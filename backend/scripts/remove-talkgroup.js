/**
 * Deletes every call on one talkgroup, and its audio with it.
 *
 *   docker exec hamrecorder-backend-1 node /home/app/scripts/remove-talkgroup.js \
 *     --system 2msac --talkgroup 145250 --dry-run
 *   docker exec hamrecorder-backend-1 node /home/app/scripts/remove-talkgroup.js \
 *     --system 2msac --talkgroup 145250
 *
 * Replaces mongo/remove_tg.js, which could not have done this here. That script
 * hid files in Backblaze B2 - a provider this deployment does not use, whose
 * package is not installed, with empty credentials and a bucket belonging to
 * upstream openmhz - and had the system and talkgroup hardcoded to one of
 * upstream's. It also deleted call documents while leaving the audio, which is
 * the orphan problem retention.js exists to prevent.
 *
 * ALWAYS run --dry-run first and read what it reports. There is no undo.
 *
 * Starred calls are skipped by default. A star is a listener's bookmark, and
 * silently deleting a recording somebody saved is the thing retention.js goes
 * out of its way not to do. Pass --include-starred when the point is to remove
 * the talkgroup's audio regardless - a talkgroup recorded in error, or a
 * takedown - and it reports how many starred calls that took.
 *
 * Audio is deleted before the document, the same order and for the same reason
 * as retention.js: the document is the only thing naming the object key, so a
 * document deleted first leaves audio nobody can find again. A call whose audio
 * could not be deleted keeps its document, and re-running picks it up.
 *
 * The Talkgroup record itself is not touched - only calls. Removing the
 * talkgroup from the system is an admin-site job.
 */
const mongoose = require("mongoose");

const mongoUrl = require("../config/mongo-url");
const { bucket: default_bucket, endpoint } = require("../config/s3");
const { deleteAudio, targetKey } = require("../retention");
const callSchema = require("../models/callSchema");
const StarredCall = require("../models/starred_call");

/** Calls handled per pass. */
const PAGE_SIZE = 500;

function parseArgs(argv) {
	const args = { dryRun: false, includeStarred: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "--include-starred") args.includeStarred = true;
		// Lowercased to match storage: uploads.js lowercases shortName before
		// saving, so "2MSAC" would otherwise match nothing and report a clean
		// "no calls found" for a talkgroup that is very much there.
		else if (arg === "--system") args.system = (argv[++i] || "").toLowerCase();
		else if (arg === "--talkgroup") args.talkgroup = Number(argv[++i]);
		else return { error: `Unknown argument: ${arg}` };
	}
	if (!args.system) return { error: "--system <shortName> is required" };
	if (!Number.isInteger(args.talkgroup)) return { error: "--talkgroup <number> is required" };
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.error) {
		console.error(`${args.error}\n`);
		console.error("Usage: node scripts/remove-talkgroup.js --system <shortName> --talkgroup <num>");
		console.error("                                       [--dry-run] [--include-starred]");
		process.exit(1);
	}

	await mongoose.connect(mongoUrl);
	const Call = mongoose.models.Call || mongoose.model("Call", callSchema);

	const filter = { shortName: args.system, talkgroupNum: args.talkgroup };
	const total = await Call.countDocuments(filter);

	console.log(`Store     : ${default_bucket} at ${endpoint}`);
	console.log(`Talkgroup : ${args.system}/${args.talkgroup}`);
	console.log(`Calls     : ${total}${args.dryRun ? "   (dry run - nothing will be deleted)" : ""}`);
	if (args.includeStarred) {
		console.log("Starred   : INCLUDED - starred calls will be deleted too");
	}

	if (total === 0) {
		console.log("\nNothing to do.");
		await mongoose.disconnect();
		return;
	}

	let examined = 0, keptStarred = 0, audioDeleted = 0, audioFailed = 0, callsDeleted = 0;
	const sample = [];
	let afterId = null;

	for (;;) {
		const page = await Call.find(
			afterId ? { ...filter, _id: { $gt: afterId } } : filter,
			{ _id: 1, objectKey: 1, bucket: 1, time: 1, len: 1 }
		).sort({ _id: 1 }).limit(PAGE_SIZE).lean();

		if (page.length === 0) break;
		examined += page.length;
		afterId = page[page.length - 1]._id;

		let deletable = page;
		if (!args.includeStarred) {
			const starredRows = await StarredCall.distinct("callId", {
				callId: { $in: page.map(call => call._id) }
			});
			const starred = new Set(starredRows.map(id => id.toHexString()));
			deletable = page.filter(call => {
				if (starred.has(call._id.toHexString())) { keptStarred++; return false; }
				return true;
			});
		}
		if (deletable.length === 0) continue;

		for (const call of deletable) {
			if (sample.length < 10) {
				sample.push(`${call.time && call.time.toISOString()}  ${Math.round(call.len || 0)}s  ${call.objectKey || "(no audio)"}`);
			}
		}

		// A call with no objectKey has nothing in the store - its document
		// should still go.
		const targets = deletable
			.filter(call => call.objectKey)
			.map(call => ({ bucket: call.bucket || default_bucket, objectKey: call.objectKey }));

		if (args.dryRun) {
			audioDeleted += targets.length;
			callsDeleted += deletable.length;
			continue;
		}

		const failed = targets.length > 0 ? await deleteAudio(targets) : new Set();
		audioDeleted += targets.length - failed.size;
		audioFailed += failed.size;

		const removable = deletable.filter(call =>
			!call.objectKey || !failed.has(targetKey(call.bucket || default_bucket, call.objectKey))
		);
		if (removable.length === 0) continue;

		const ids = removable.map(call => call._id);
		const result = await Call.deleteMany({ _id: { $in: ids } });
		callsDeleted += (result && result.deletedCount) || 0;

		// Only reachable with --include-starred, or if a star landed mid-run.
		// Either way the rows would otherwise point at calls that are gone.
		await StarredCall.deleteMany({ callId: { $in: ids } });

		console.log(`  ${callsDeleted} calls deleted...`);
	}

	console.log(`\nExamined            : ${examined}`);
	console.log(`Kept as starred     : ${keptStarred}${keptStarred > 0 ? "  (use --include-starred to delete these too)" : ""}`);
	console.log(`Recordings deleted  : ${audioDeleted}`);
	console.log(`Calls deleted       : ${callsDeleted}`);
	if (audioFailed > 0) {
		console.log(`Recordings failed   : ${audioFailed}  - their calls were kept, re-running is safe`);
	}
	if (sample.length > 0) {
		console.log(`\n${args.dryRun ? "Would delete" : "Deleted"}, first ${sample.length}:`);
		for (const line of sample) console.log(`  ${line}`);
		if (callsDeleted > sample.length) console.log(`  ... and ${callsDeleted - sample.length} more`);
	}
	if (args.dryRun) {
		console.log("\nDry run - nothing was deleted. Re-run without --dry-run to apply.");
	}

	await mongoose.disconnect();
}

main().catch(err => {
	console.error(`Failed: ${err}`);
	process.exit(1);
});
