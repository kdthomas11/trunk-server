/**
 * One-off migration: drop the legacy `star` counter from calls.
 *
 *   docker exec hamrecorder-backend-1 node /home/app/scripts/remove-legacy-star-field.js
 *   docker exec hamrecorder-backend-1 node /home/app/scripts/remove-legacy-star-field.js --dry-run
 *
 * `star` was a single global number on each call. Anyone starring a call
 * starred it for everybody, and "show only starred calls" showed everyone's,
 * which is why it looked broken. StarredCall replaced it with a (user, call)
 * pair, and nothing has read the counter since - build_call_list() computes
 * `star` from the listener's own StarredCall rows.
 *
 * The field is already out of callSchema, so mongoose no longer surfaces it and
 * leaving it in place is harmless. This is hygiene: it removes a field that
 * looks authoritative but is not, so nobody reaches for it later.
 *
 * The counter cannot be converted into StarredCall rows. It recorded how many
 * people starred a call, never which people, so there is nothing to attribute
 * the stars to - the information was already lost. Anything non-zero is
 * reported below before it goes, so the loss is visible rather than silent.
 *
 * Idempotent: $unset on a document that has no `star` is a no-op, so this is
 * safe to run more than once.
 *
 * Pass --dry-run to see the counts without writing anything.
 */
const mongoose = require("mongoose");

const DRY_RUN = process.argv.includes("--dry-run");

// Built the same way as index.js, from the same environment the container
// already has, so this connects to whatever the service connects to.
function mongoUrl() {
	const host = typeof process.env["MONGO_HOST"] !== "undefined" ? process.env["MONGO_HOST"] : "mongo";
	const port = typeof process.env["MONGO_PORT"] !== "undefined" ? process.env["MONGO_PORT"] : 27017;
	const user = process.env["MONGO_USER"];
	const password = process.env["MONGO_PASSWORD"];
	if (typeof user !== "undefined" && typeof password !== "undefined") {
		return "mongodb://" + user + ":" + password + "@" + host + ":" + port + "/scanner";
	}
	return "mongodb://" + host + ":" + port + "/scanner";
}

async function main() {
	const url = mongoUrl();
	await mongoose.connect(url);
	console.log("Connected to " + url.replace(/\/\/[^@]*@/, "//***@") + (DRY_RUN ? "  (dry run)" : ""));

	// Raw collection access rather than the model: `star` is no longer in the
	// schema, so mongoose would strip it from anything it handed back.
	const db = mongoose.connection.db;

	for (const name of ["calls", "frozencalls"]) {
		const collection = db.collection(name);
		const withField = await collection.countDocuments({ star: { $exists: true } });
		const nonZero = await collection.countDocuments({ star: { $gt: 0 } });

		console.log(`\n${name}:`);
		console.log(`  documents carrying star : ${withField}`);
		console.log(`  of those, star > 0      : ${nonZero}`);

		if (nonZero > 0) {
			// Printed so the discarded counts are on the record somewhere before
			// they are removed.
			const sample = await collection
				.find({ star: { $gt: 0 } }, { projection: { _id: 1, shortName: 1, talkgroupNum: 1, star: 1 } })
				.limit(20)
				.toArray();
			console.log("  discarding these counts:");
			for (const doc of sample) {
				console.log(`    ${doc._id}  ${doc.shortName}/${doc.talkgroupNum}  star=${doc.star}`);
			}
			if (nonZero > sample.length) {
				console.log(`    ... and ${nonZero - sample.length} more`);
			}
		}

		if (DRY_RUN) {
			console.log("  dry run - nothing written");
			continue;
		}
		if (withField === 0) {
			console.log("  nothing to do");
			continue;
		}

		const result = await collection.updateMany({ star: { $exists: true } }, { $unset: { star: "" } });
		console.log(`  unset on ${result.modifiedCount} documents`);
	}

	await mongoose.disconnect();
	console.log("\nDone.");
}

main().catch(err => {
	console.error("Migration failed: " + err);
	process.exit(1);
});
