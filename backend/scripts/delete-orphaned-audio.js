/**
 * Deletes call audio that no call document points at.
 *
 *   docker exec hamrecorder-backend-1 node /home/app/scripts/delete-orphaned-audio.js --dry-run
 *   docker exec hamrecorder-backend-1 node /home/app/scripts/delete-orphaned-audio.js
 *
 * Clears the backlog left by the old retention sweep. db.cleanOldCalls() used
 * to delete the call document and nothing else, so every expired call left its
 * .m4a in the bucket with nothing naming its key - unreachable through the app,
 * invisible in the UI, and paying for storage forever. retention.js now deletes
 * the object before the document, so no new orphans are made; this clears the
 * ones already there. On the machine this was written against, 4,454 of 30,542
 * local objects were past the archive window.
 *
 * ALWAYS run --dry-run first and read the sample it prints. This deletes audio
 * that cannot be recovered.
 *
 * How it decides. The set of object keys the database still references is read
 * once, up front; anything in the bucket that is not in that set is an orphan.
 * That snapshot is the reason for the age guard below - see SAFETY_HOURS.
 *
 * Only the configured S3_BUCKET is listed. A database migrated between object
 * stores can hold calls whose `bucket` is some older one; those are not
 * examined and are not at risk, but their orphans are not collected either.
 * Point S3_BUCKET at the old store and run it again to sweep that one.
 *
 * Safe to re-run: the second pass finds nothing.
 */
const { ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const mongoose = require("mongoose");

const mongoUrl = require("../config/mongo-url");
const { s3Client, bucket, endpoint } = require("../config/s3");
const callSchema = require("../models/callSchema");

const DRY_RUN = process.argv.includes("--dry-run");

/** The prefix uploads.js writes under. */
const PREFIX = "media/";
/** Hard limit of the DeleteObjects API. */
const S3_DELETE_BATCH = 1000;

/**
 * An object younger than this is never touched, however orphaned it looks.
 *
 * uploads.js does PutObject and then call.save(), so for a moment a live
 * recording has no document - and a failed save leaves one that never will.
 * More importantly the key snapshot is taken once, at the start: an object
 * uploaded while this script is running would not be in it. Requiring the
 * object to predate the snapshot by a day means anything examined here had its
 * document written long before the snapshot was read, so absence from the
 * snapshot is real. Real orphans are older than the whole archive window, so
 * nothing worth collecting is missed.
 */
const SAFETY_HOURS = Number(process.env["ORPHAN_SAFETY_HOURS"] ?? 24);

function human(bytes) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let n = bytes, i = 0;
	while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
	return `${n.toFixed(1)} ${units[i]}`;
}

async function main() {
	if (!Number.isFinite(SAFETY_HOURS) || SAFETY_HOURS < 0) {
		console.error(`ORPHAN_SAFETY_HOURS must be a number of hours >= 0, got "${process.env["ORPHAN_SAFETY_HOURS"]}"`);
		process.exit(1);
	}

	await mongoose.connect(mongoUrl);
	const Call = mongoose.models.Call || mongoose.model("Call", callSchema);

	console.log(`Bucket:  ${bucket} at ${endpoint}${DRY_RUN ? "   (dry run - nothing will be deleted)" : ""}`);
	console.log(`Keeping anything modified in the last ${SAFETY_HOURS}h.`);

	// One pass over the collection, projecting a single field. Held in memory
	// because the alternative is a query per listed page, and objectKey carries
	// no index - that would be a collection scan every thousand objects. At
	// ~60 bytes a key this is a few MB for a database of this size.
	process.stdout.write("Reading the object keys the database still references... ");
	const referenced = new Set();
	for await (const row of Call.find({}, { objectKey: 1, _id: 0 }).lean().cursor()) {
		if (row.objectKey) referenced.add(row.objectKey);
	}
	console.log(`${referenced.size}`);

	const cutoff = new Date(Date.now() - SAFETY_HOURS * 60 * 60 * 1000);
	const client = s3Client();

	let token = undefined;
	let seen = 0, tooNew = 0, orphans = 0, deleted = 0, failed = 0;
	/** Bytes of everything found orphaned, and of what was actually removed. */
	let orphanBytes = 0, reclaimedBytes = 0;
	let pending = [];
	const sample = [];

	async function flush() {
		if (pending.length === 0) return;
		const chunk = pending;
		pending = [];
		if (DRY_RUN) return;
		const chunkBytes = chunk.reduce((sum, obj) => sum + obj.size, 0);
		try {
			const out = await client.send(new DeleteObjectsCommand({
				Bucket: bucket,
				Delete: { Objects: chunk.map(obj => ({ Key: obj.key })), Quiet: true },
			}));
			const errors = (out && out.Errors) || [];
			// Sizes are subtracted back out rather than added up, so the
			// reclaimed figure reports what was actually freed and not what
			// was attempted.
			const lost = new Set(errors.map(err => err.Key));
			for (const err of errors) {
				console.warn(`  could not delete ${err.Key}: ${err.Code} ${err.Message}`);
			}
			failed += errors.length;
			deleted += chunk.length - errors.length;
			reclaimedBytes += chunkBytes - chunk
				.filter(obj => lost.has(obj.key))
				.reduce((sum, obj) => sum + obj.size, 0);
		} catch (err) {
			console.warn(`  DeleteObjects failed for ${chunk.length} keys: ${err}`);
			failed += chunk.length;
		}
		console.log(`  ${deleted} deleted...`);
	}

	do {
		const page = await client.send(new ListObjectsV2Command({
			Bucket: bucket,
			Prefix: PREFIX,
			ContinuationToken: token,
		}));

		for (const obj of page.Contents || []) {
			seen++;
			if (referenced.has(obj.Key)) continue;
			if (obj.LastModified && obj.LastModified > cutoff) { tooNew++; continue; }

			orphans++;
			orphanBytes += obj.Size || 0;
			if (sample.length < 10) sample.push(`${obj.Key}  ${human(obj.Size || 0)}  ${obj.LastModified && obj.LastModified.toISOString()}`);

			pending.push({ key: obj.Key, size: obj.Size || 0 });
			if (pending.length >= S3_DELETE_BATCH) await flush();
		}

		token = page.IsTruncated ? page.NextContinuationToken : undefined;
	} while (token);

	await flush();

	console.log(`\nObjects listed       : ${seen}`);
	console.log(`Still referenced     : ${seen - orphans - tooNew}`);
	console.log(`Held back as too new : ${tooNew}`);
	console.log(`Orphaned             : ${orphans}  (${human(orphanBytes)})`);
	if (sample.length > 0) {
		console.log(`\n${DRY_RUN ? "Would delete" : "Deleted"}, first ${sample.length}:`);
		for (const line of sample) console.log(`  ${line}`);
		if (orphans > sample.length) console.log(`  ... and ${orphans - sample.length} more`);
	}
	if (DRY_RUN) {
		console.log(`\nDry run - nothing was deleted. Re-run without --dry-run to reclaim ${human(orphanBytes)}.`);
	} else {
		console.log(`\nDeleted ${deleted} objects, reclaiming ${human(reclaimedBytes)}.`);
		if (failed > 0) console.log(`${failed} could not be deleted - listed above. Re-running is safe.`);
	}

	await mongoose.disconnect();
}

main().catch(err => {
	console.error(`Failed: ${err}`);
	process.exit(1);
});
