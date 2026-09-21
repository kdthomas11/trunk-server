/**
 * The retention sweep: delete calls once they age out, and their audio with
 * them - unless somebody has starred them.
 *
 * Replaces db.cleanOldCalls(), which deleted the Call document and nothing
 * else. Audio was only ever removed by a lifecycle rule configured by hand in
 * the object store (DEPLOY-PLAN.md), so on every deployment without that rule -
 * including local dev, where minio-init sets no ilm policy - the .m4a files
 * accumulated forever. Worse, they accumulated *unreachable*: the sweep deleted
 * the only document that named the object key, so the bytes stayed in the
 * bucket with nothing pointing at them.
 *
 * Deleting audio here rather than in a lifecycle rule is also what makes
 * starring able to keep a call at all. A rule on object age cannot be told
 * about exceptions; this can.
 *
 * Order matters. The object goes first, the document second. Crash in between
 * and the call survives pointing at audio that is gone - which
 * controllers/media.js already answers as a clean 404, and which the next sweep
 * retries. Document first would recreate the orphan this was written to stop.
 *
 * Existing orphans are not this sweep's job: it works from call documents, and
 * an orphan is precisely an object with no document. Run
 * scripts/delete-orphaned-audio.js once to clear the backlog.
 */
const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");

const Call = require("./models/call");
const StarredCall = require("./models/starred_call");
const { s3Client, bucket: default_bucket } = require("./config/s3");

/** Fallback when nothing in the environment says otherwise. */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * How long a call lives.
 *
 * ARCHIVE_DAYS wins, then REACT_APP_ARCHIVE_DAYS - the variable the player
 * already reads to print "30 day archive" and to bound the calendar picker.
 * Both are read so the label and the sweep cannot drift apart and promise
 * listeners an archive that is not there.
 */
function retentionDays() {
	const raw = process.env["ARCHIVE_DAYS"] ?? process.env["REACT_APP_ARCHIVE_DAYS"];
	if (raw == null || raw === "") return DEFAULT_RETENTION_DAYS;
	const days = Number(raw);
	// A typo here deletes the archive. An unset-but-declared variable arrives
	// from docker-compose as an empty string, and Number("") is 0 - a cutoff of
	// "now", which would take every call in the database on the next run. Only
	// a finite number of at least one day may move the cutoff.
	if (!Number.isFinite(days) || days < 1) {
		console.warn(`[retention] Ignoring ARCHIVE_DAYS="${raw}" - not a number of days >= 1. Using ${DEFAULT_RETENTION_DAYS}.`);
		return DEFAULT_RETENTION_DAYS;
	}
	return days;
}

/**
 * Calls recorded before this are eligible.
 *
 * Whole days, deliberately. The old code did setMonth(getMonth() - 1), so
 * retention was 28, 29, 30 or 31 days depending on which month the sweep
 * happened to run in - and in March it kept a day less than the site promises.
 */
function cutoffDate(now, days) {
	return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Calls read per page. */
const PAGE_SIZE = 500;
/** Hard limit of the DeleteObjects API. */
const S3_DELETE_BATCH = 1000;

/** Identifies one object across buckets. NUL cannot occur in a bucket name. */
function targetKey(bucket, objectKey) {
	return bucket + "\u0000" + objectKey;
}

/**
 * Which of these calls has anyone starred?
 *
 * Anyone, not one listener - there is no listener here. A star is a personal
 * bookmark, so a call has to outlive retention for as long as *any* listener
 * still wants it, and becomes deletable again only when the last star is
 * removed. Returns a Set of hex ids.
 */
async function starredIdsAmong(ids) {
	const rows = await StarredCall.distinct("callId", { callId: { $in: ids } });
	return new Set(rows.map(id => id.toHexString()));
}

/**
 * Delete these objects, grouped by the bucket each call was written to.
 *
 * Calls carry their own `bucket`, so recordings made before a bucket change
 * still resolve - the same reason controllers/media.js reads it. Grouping keeps
 * that true instead of pointing every delete at today's bucket, which on a
 * migrated database would ask the new bucket to delete keys it never held
 * (succeeding, silently) and leave the real objects behind.
 *
 * Returns the targets that could not be deleted, so their documents can be kept
 * for the next run.
 */
async function deleteAudio(targets) {
	const failed = new Set();
	const byBucket = new Map();
	for (const target of targets) {
		if (!byBucket.has(target.bucket)) byBucket.set(target.bucket, []);
		byBucket.get(target.bucket).push(target.objectKey);
	}

	for (const [bucket, keys] of byBucket) {
		for (let i = 0; i < keys.length; i += S3_DELETE_BATCH) {
			const chunk = keys.slice(i, i + S3_DELETE_BATCH);
			try {
				// Quiet, so the response carries only failures. A verbose
				// response repeats all thousand keys back for no gain: a key
				// that is not reported failed is one that is gone, and delete
				// is idempotent - an already-absent key reports as deleted.
				const out = await s3Client().send(new DeleteObjectsCommand({
					Bucket: bucket,
					Delete: { Objects: chunk.map(Key => ({ Key })), Quiet: true },
				}));
				for (const err of (out && out.Errors) || []) {
					console.warn(`[retention] Could not delete ${bucket}/${err.Key}: ${err.Code} ${err.Message}`);
					failed.add(targetKey(bucket, err.Key));
				}
			} catch (err) {
				// The whole request failed - store unreachable, credentials
				// wrong, bucket gone. Fail every key in the chunk so their
				// documents stay put rather than orphaning the audio.
				console.warn(`[retention] DeleteObjects failed for ${bucket} (${chunk.length} keys): ${err}`);
				for (const key of chunk) failed.add(targetKey(bucket, key));
			}
		}
	}
	return failed;
}

/**
 * One pass over everything past the cutoff.
 *
 * Paged by ascending _id rather than by repeatedly asking for the oldest N.
 * Starred calls stay in the result set after they are skipped, so "read the
 * first 500 expired calls, delete some, repeat" would hand back the same
 * starred calls forever once they fill a page. The cursor walks past them.
 *
 * `deleter` is injected so the tests can exercise the sweep without an object
 * store, and `pageSize` so they can cross a page boundary without fabricating
 * five hundred documents to do it.
 */
async function sweep(options = {}) {
	const now = options.now || new Date();
	const dryRun = options.dryRun === true;
	const deleter = options.deleter || deleteAudio;
	const pageSize = options.pageSize || PAGE_SIZE;
	const days = retentionDays();
	const cutoff = cutoffDate(now, days);

	const summary = {
		cutoff, days, dryRun,
		examined: 0, kept: 0, audioDeleted: 0, audioFailed: 0, callsDeleted: 0
	};
	let afterId = null;

	for (;;) {
		const filter = { time: { $lt: cutoff } };
		if (afterId) filter._id = { $gt: afterId };

		const page = await Call.find(filter, { _id: 1, shortName: 1, objectKey: 1, bucket: 1 })
			.sort({ _id: 1 })
			.limit(pageSize)
			.lean();

		if (!page || page.length === 0) break;

		summary.examined += page.length;
		afterId = page[page.length - 1]._id;

		// Read as late as possible before anything is destroyed, to keep the
		// window in which a star lands on a call already chosen for deletion as
		// small as it can be without a transaction. A star arriving inside that
		// window is lost; it is seconds wide, at 3am, on a call older than the
		// entire archive.
		const starred = await starredIdsAmong(page.map(call => call._id));

		const deletable = [];
		for (const call of page) {
			if (starred.has(call._id.toHexString())) {
				summary.kept++;
				continue;
			}
			deletable.push(call);
		}
		if (deletable.length === 0) continue;

		// A call with no objectKey has nothing in the store to delete - legacy
		// rows, and any upload whose PutObject failed before the document was
		// saved. Its document should still go.
		const targets = deletable
			.filter(call => call.objectKey)
			.map(call => ({ bucket: call.bucket || default_bucket, objectKey: call.objectKey }));

		if (dryRun) {
			summary.audioDeleted += targets.length;
			summary.callsDeleted += deletable.length;
			continue;
		}

		const failed = targets.length > 0 ? await deleter(targets) : new Set();
		summary.audioDeleted += targets.length - failed.size;
		summary.audioFailed += failed.size;

		// Only documents whose audio is actually gone. Anything held back is
		// retried on the next run, which is what makes a half-finished sweep
		// safe to lose.
		const removable = deletable.filter(call =>
			!call.objectKey || !failed.has(targetKey(call.bucket || default_bucket, call.objectKey))
		);
		if (removable.length === 0) continue;

		const ids = removable.map(call => call._id);
		const res = await Call.deleteMany({ _id: { $in: ids } });
		summary.callsDeleted += (res && res.deletedCount) || 0;

		// Sweeps up a star that landed in the window described above, so
		// starred_calls cannot accumulate rows pointing at calls that are gone.
		await StarredCall.deleteMany({ callId: { $in: ids } });
	}

	return summary;
}

/**
 * The scheduled entry point. Keeps the name index.js has always called.
 */
exports.cleanOldCalls = async function (options = {}) {
	try {
		const summary = await sweep(options);
		console.log(
			`[retention] ${summary.dryRun ? "(dry run) " : ""}` +
			`${summary.callsDeleted} calls and ${summary.audioDeleted} recordings removed, ` +
			`older than ${summary.days} days (before ${summary.cutoff.toISOString()}). ` +
			`${summary.kept} kept as starred, ${summary.examined} examined` +
			(summary.audioFailed > 0
				? `, ${summary.audioFailed} recordings could not be deleted and will be retried`
				: "")
		);
		return summary;
	} catch (err) {
		// Never throw out of the scheduler: an unhandled rejection here takes
		// the backend down, and a failed sweep is a night of extra storage
		// rather than an outage.
		console.error(`[retention] Sweep failed: ${err}`);
		return null;
	}
};

exports.sweep = sweep;
exports.cutoffDate = cutoffDate;
exports.retentionDays = retentionDays;
exports.deleteAudio = deleteAudio;
// Exported for scripts/remove-talkgroup.js, which deletes audio the same way
// and has to read the failures deleteAudio() reports back. Sharing the join
// keeps one definition of how a target is identified rather than two that
// agree until one of them changes.
exports.targetKey = targetKey;
