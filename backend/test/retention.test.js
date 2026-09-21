/**
 * The retention sweep.
 *
 *   docker exec -w /home/app hamrecorder-backend-1 node test/run.js
 *
 * Two rules are worth a test each, because breaking either is silent and
 * expensive:
 *
 *   - a starred call is not deleted, and becomes deletable again the moment the
 *     last star goes;
 *   - a call's audio is deleted before its document, and the document is kept
 *     if the audio could not be deleted. Reversing that order, or deleting the
 *     document anyway, recreates the orphaned .m4a files this replaced.
 *
 * Mongo and the object store are faked. The find() fake applies the real filter
 * rather than handing back a fixed list, so the paging cursor is exercised for
 * real - a sweep that fails to page past starred calls loops forever, which a
 * fake ignoring the filter would not catch.
 */
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const retention = require("../retention");
const Call = require("../models/call");
const StarredCall = require("../models/starred_call");

const SHORT_NAME = "2msac";
const NOW = new Date("2026-09-19T03:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// --- fakes ------------------------------------------------------------------

/** Every call the faked Mongo holds, oldest _id first. */
let storedCalls = [];
/** Hex call ids somebody has starred. */
let starred = new Set();
/** Object keys the faked store holds, as "bucket\0key". */
let storedObjects = new Set();
/** Keys the faked store refuses to delete. */
let undeletable = new Set();
/** Every DeleteObjects call the sweep made, for asserting on grouping. */
let deleteCalls = [];

const realFind = Call.find;
const realDeleteMany = Call.deleteMany;
const realDistinct = StarredCall.distinct;
const realStarDeleteMany = StarredCall.deleteMany;

/**
 * ObjectIds that sort in creation order.
 *
 * The sweep pages with `_id: { $gt: afterId }`, so ids that do not increase
 * would make these tests pass for the wrong reason.
 */
let counter = 0;
function nextId() {
	counter++;
	return ObjectId.createFromHexString(counter.toString(16).padStart(24, "0"));
}

function makeCall(overrides = {}) {
	const id = overrides._id || nextId();
	const call = {
		_id: id,
		shortName: SHORT_NAME,
		bucket: "hamrecorder-dev",
		objectKey: `media/${SHORT_NAME}/145250/${id.toHexString()}.m4a`,
		// Old enough to be swept unless a test says otherwise.
		time: new Date(NOW.getTime() - 45 * DAY_MS),
		...overrides
	};
	storedCalls.push(call);
	if (call.objectKey) storedObjects.add(call.bucket + "\u0000" + call.objectKey);
	return call;
}

function star(call) {
	starred.add(call._id.toHexString());
}

/** Stands in for the object store. Mirrors deleteAudio's contract. */
async function fakeDeleter(targets) {
	deleteCalls.push(targets.map(t => t.bucket + "\u0000" + t.objectKey));
	const failed = new Set();
	for (const target of targets) {
		const key = target.bucket + "\u0000" + target.objectKey;
		if (undeletable.has(key)) {
			failed.add(key);
			continue;
		}
		storedObjects.delete(key);
	}
	return failed;
}

function run(options = {}) {
	return retention.sweep({ now: NOW, deleter: fakeDeleter, ...options });
}

beforeEach(() => {
	storedCalls = [];
	starred = new Set();
	storedObjects = new Set();
	undeletable = new Set();
	deleteCalls = [];
	counter = 0;
	delete process.env.ARCHIVE_DAYS;
	delete process.env.REACT_APP_ARCHIVE_DAYS;

	// Applies the real filter, sort and limit, so the paging cursor is under
	// test rather than assumed.
	Call.find = (filter) => ({
		sort: () => ({
			limit: (n) => ({
				lean: async () => storedCalls
					.filter(call => call.time < filter.time.$lt)
					.filter(call => !filter._id || call._id.toHexString() > filter._id.$gt.toHexString())
					.sort((a, b) => a._id.toHexString() < b._id.toHexString() ? -1 : 1)
					.slice(0, n)
			})
		})
	});

	Call.deleteMany = async (filter) => {
		const ids = new Set(filter._id.$in.map(id => id.toHexString()));
		const before = storedCalls.length;
		storedCalls = storedCalls.filter(call => !ids.has(call._id.toHexString()));
		return { deletedCount: before - storedCalls.length };
	};

	StarredCall.distinct = async (field, filter) =>
		filter.callId.$in.filter(id => starred.has(id.toHexString()));

	StarredCall.deleteMany = async (filter) => {
		for (const id of filter.callId.$in) starred.delete(id.toHexString());
		return { deletedCount: 0 };
	};
});

afterEach(() => {
	Call.find = realFind;
	Call.deleteMany = realDeleteMany;
	StarredCall.distinct = realDistinct;
	StarredCall.deleteMany = realStarDeleteMany;
});

/** Is this call still in the faked database? */
function callExists(call) {
	return storedCalls.some(c => c._id.toHexString() === call._id.toHexString());
}

/** Is this call's audio still in the faked store? */
function audioExists(call) {
	return storedObjects.has(call.bucket + "\u0000" + call.objectKey);
}

// --- the archive window -----------------------------------------------------

describe("how long a call is kept", () => {

	/**
	 * The old sweep did setMonth(getMonth() - 1), which is 28, 29, 30 or 31
	 * days depending on the month it ran in. The site promises 30.
	 */
	test("the cutoff is whole days, not a calendar month", () => {
		const cutoff = retention.cutoffDate(new Date("2026-03-31T03:00:00.000Z"), 30);

		assert.equal(cutoff.toISOString(), "2026-03-01T03:00:00.000Z");
	});

	test("defaults to 30 days when nothing is configured", () => {
		assert.equal(retention.retentionDays(), 30);
	});

	test("ARCHIVE_DAYS moves the window", () => {
		process.env.ARCHIVE_DAYS = "7";

		assert.equal(retention.retentionDays(), 7);
	});

	test("falls back to the value the player already reads", () => {
		process.env.REACT_APP_ARCHIVE_DAYS = "14";

		assert.equal(retention.retentionDays(), 14);
	});

	/**
	 * docker-compose passes a declared-but-unset variable through as "", and
	 * Number("") is 0 - a cutoff of "now", which takes the entire archive on
	 * the next run.
	 */
	test("an empty ARCHIVE_DAYS does not mean zero days", () => {
		process.env.ARCHIVE_DAYS = "";

		assert.equal(retention.retentionDays(), 30);
	});

	test("a nonsense ARCHIVE_DAYS does not mean zero days", () => {
		process.env.ARCHIVE_DAYS = "thirty";

		assert.equal(retention.retentionDays(), 30);
	});

	test("ARCHIVE_DAYS below a day is refused", () => {
		process.env.ARCHIVE_DAYS = "0";

		assert.equal(retention.retentionDays(), 30);
	});

	test("a call inside the window is left alone", async () => {
		const recent = makeCall({ time: new Date(NOW.getTime() - 3 * DAY_MS) });

		const summary = await run();

		assert.equal(summary.examined, 0);
		assert.equal(callExists(recent), true);
		assert.equal(audioExists(recent), true);
	});
});

// --- audio -----------------------------------------------------------------

describe("deleting the audio as well as the call", () => {

	test("an expired call loses both its document and its recording", async () => {
		const call = makeCall();

		const summary = await run();

		assert.equal(callExists(call), false);
		assert.equal(audioExists(call), false);
		assert.equal(summary.callsDeleted, 1);
		assert.equal(summary.audioDeleted, 1);
	});

	/**
	 * The whole point of the change. Deleting the document while leaving the
	 * object is what filled the bucket with .m4a files nothing could reach.
	 */
	test("no expired call is left with audio behind it", async () => {
		const calls = [makeCall(), makeCall(), makeCall()];

		await run();

		for (const call of calls) {
			assert.equal(callExists(call), false);
			assert.equal(audioExists(call), false, `orphaned ${call.objectKey}`);
		}
		assert.equal(storedObjects.size, 0);
	});

	/**
	 * Calls carry the bucket they were written to so a database migrated
	 * between object stores still resolves. Deleting everything from today's
	 * bucket would ask it for keys it never held - succeeding, silently - and
	 * leave the real objects in the old one.
	 */
	test("each recording is deleted from the bucket its call names", async () => {
		const here = makeCall({ bucket: "hamrecorder-prod" });
		const legacy = makeCall({ bucket: "openmhz-west" });

		await run();

		const sent = deleteCalls.flat();
		assert.ok(sent.includes("hamrecorder-prod\u0000" + here.objectKey));
		assert.ok(sent.includes("openmhz-west\u0000" + legacy.objectKey));
		assert.equal(storedObjects.size, 0);
	});

	test("a call with no stored audio is still removed", async () => {
		const call = makeCall({ objectKey: undefined });

		const summary = await run();

		assert.equal(callExists(call), false);
		assert.equal(deleteCalls.length, 0, "nothing to ask the store for");
		assert.equal(summary.callsDeleted, 1);
	});

	/**
	 * The document is the only thing naming the object key. Delete it while the
	 * object is still there and the object can never be found again, so a
	 * failed delete has to keep the document for the next run.
	 */
	test("a call whose audio could not be deleted is kept for the next run", async () => {
		const stuck = makeCall();
		const fine = makeCall();
		undeletable.add(stuck.bucket + "\u0000" + stuck.objectKey);

		const summary = await run();

		assert.equal(callExists(stuck), true, "kept so the audio can be retried");
		assert.equal(audioExists(stuck), true);
		assert.equal(summary.audioFailed, 1);

		assert.equal(callExists(fine), false, "one failure must not block the rest");
		assert.equal(audioExists(fine), false);
	});

	test("the retry succeeds once the store accepts the delete", async () => {
		const stuck = makeCall();
		undeletable.add(stuck.bucket + "\u0000" + stuck.objectKey);
		await run();

		undeletable.clear();
		const summary = await run();

		assert.equal(callExists(stuck), false);
		assert.equal(audioExists(stuck), false);
		assert.equal(summary.audioFailed, 0);
	});

	test("a dry run deletes nothing at all", async () => {
		const call = makeCall();

		const summary = await run({ dryRun: true });

		assert.equal(callExists(call), true);
		assert.equal(audioExists(call), true);
		assert.equal(deleteCalls.length, 0);
		assert.equal(summary.dryRun, true);
		assert.equal(summary.callsDeleted, 1, "reports what it would have done");
	});
});

// --- stars ------------------------------------------------------------------

describe("a starred call outlives the archive window", () => {

	test("a starred call keeps both its document and its recording", async () => {
		const kept = makeCall();
		star(kept);

		const summary = await run();

		assert.equal(callExists(kept), true);
		assert.equal(audioExists(kept), true);
		assert.equal(summary.kept, 1);
		assert.equal(summary.callsDeleted, 0);
	});

	test("the store is never asked to delete a starred recording", async () => {
		const kept = makeCall();
		star(kept);

		await run();

		assert.equal(deleteCalls.flat().length, 0);
	});

	/**
	 * A star is one listener's bookmark, but retention has no listener. The
	 * call has to survive for as long as anyone still wants it, so one star is
	 * enough to keep it for everybody.
	 */
	test("one listener's star keeps the call for everyone", async () => {
		const kept = makeCall();
		const swept = makeCall();
		star(kept);

		await run();

		assert.equal(callExists(kept), true);
		assert.equal(callExists(swept), false);
	});

	/** The other half of the request: unstarring puts it back in scope. */
	test("removing the last star makes the call deletable again", async () => {
		const call = makeCall();
		star(call);
		await run();
		assert.equal(callExists(call), true);

		starred.delete(call._id.toHexString());
		await run();

		assert.equal(callExists(call), false);
		assert.equal(audioExists(call), false);
	});

	test("a star that survives is not swept up with the deleted calls", async () => {
		const kept = makeCall();
		makeCall();
		star(kept);

		await run();

		assert.equal(starred.has(kept._id.toHexString()), true);
	});

	/**
	 * Starred calls stay in the result set after they are skipped. Asking
	 * repeatedly for "the oldest N expired calls" would hand back the same
	 * starred page forever once stars fill one; the cursor has to walk past
	 * them. With a page size of 2 and two starred calls, a sweep that does not
	 * page never reaches the third.
	 */
	test("a page of nothing but starred calls does not stall the sweep", async () => {
		const first = makeCall();
		const second = makeCall();
		const third = makeCall();
		star(first);
		star(second);

		const summary = await run({ pageSize: 2 });

		assert.equal(callExists(first), true);
		assert.equal(callExists(second), true);
		assert.equal(callExists(third), false, "the sweep never got past the starred page");
		assert.equal(summary.kept, 2);
		assert.equal(summary.examined, 3);
	});

	test("starred and unstarred calls interleave across pages", async () => {
		const calls = [];
		for (let i = 0; i < 7; i++) calls.push(makeCall());
		star(calls[0]);
		star(calls[3]);
		star(calls[6]);

		const summary = await run({ pageSize: 2 });

		assert.equal(summary.kept, 3);
		assert.equal(summary.callsDeleted, 4);
		assert.equal(callExists(calls[0]), true);
		assert.equal(callExists(calls[3]), true);
		assert.equal(callExists(calls[6]), true);
		assert.equal(callExists(calls[1]), false);
	});
});
