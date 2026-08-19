/**
 * Characterization tests for the call payloads.
 *
 *   docker exec -w /home/app hamrecorder-backend-1 node test/run.js
 *
 * Two functions in controllers/calls.js build what the client receives:
 * build_call_list for the HTTP list, package_call for a single call. They were
 * written separately and have drifted - `patches` is on one, `shortName`,
 * `timeString`, `dateString`, `path` and `name` on the other - so these tests
 * pin both shapes before anything tries to unify them.
 *
 * They also pin the rule that is easy to break silently and expensive when
 * broken: the transcript is Supporter-only.
 *
 * The three tests about the audio URL are skipped and describe where this
 * should end up rather than where it is - see the comment above them.
 *
 * Mongo and S3 are the only things faked. The real handlers, the real payload
 * builders and the real entitlement logic all run.
 */
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { ObjectId } = require("mongodb");

// Must be set before controllers/media.js is required: it reads this at module
// load to build playback URLs, and the assertions below depend on the value.
process.env.REACT_APP_BACKEND_SERVER = "https://api.example.test";

const calls = require("../controllers/calls");
const Call = require("../models/call");
const StarredCall = require("../models/starred_call");

const SHORT_NAME = "2msac";

/** A call document as Mongo would hand it back. */
function makeCall(overrides = {}) {
	const id = new ObjectId();
	return {
		_id: id,
		shortName: SHORT_NAME,
		talkgroupNum: 145250,
		path: "/2msac/2026/8/19/",
		name: "145250-1787104423.m4a",
		time: new Date("2026-08-19T01:53:43.000Z"),
		srcList: [],
		freq: 145250000,
		patches: [],
		len: 10.79,
		// What uploads.js stores: a URL straight to the object store. Nothing
		// should hand this to a client.
		url: `http://media.example.test/bucket/media/${SHORT_NAME}/145250/x.m4a`,
		objectKey: `media/${SHORT_NAME}/145250/x.m4a`,
		bucket: "hamrecorder-dev",
		transcriptStatus: "none",
		transcript: null,
		...overrides
	};
}

// --- fakes ------------------------------------------------------------------

/** Calls the faked Mongo will return from a list query. */
let storedCalls = [];
/** Calls the faked Mongo will return from findById, keyed by hex id. */
let storedById = new Map();
/** Call ids the current listener has starred. */
let starredIds = [];

let server;
let baseUrl;
/** Set per-test; becomes req.listener. */
let listener = null;

before(async () => {
	Call.find = () => ({ sort: () => ({ limit: () => Promise.resolve(storedCalls) }) });
	Call.findById = (id) => ({ exec: async () => storedById.get(id.toHexString()) || null });
	StarredCall.find = async () => starredIds.map(id => ({ callId: id }));

	const app = express();
	// Stands in for requireListener, which the real routes are gated by.
	app.use((req, res, next) => { req.listener = listener; next(); });
	app.get("/:shortName/calls/latest", calls.get_latest_calls);
	app.get("/:shortName/call/:id", calls.get_call);

	await new Promise(resolve => { server = app.listen(0, resolve); });
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

beforeEach(() => {
	storedCalls = [];
	storedById = new Map();
	starredIds = [];
	listener = { _id: new ObjectId(), plan: "free" };
});

/** Puts a call behind both the list query and findById. */
function store(call) {
	storedCalls = [call];
	storedById.set(call._id.toHexString(), call);
	return call;
}

async function getList() {
	const res = await fetch(`${baseUrl}/${SHORT_NAME}/calls/latest`);
	return { status: res.status, body: await res.json() };
}

async function getOne(call) {
	const res = await fetch(`${baseUrl}/${SHORT_NAME}/call/${call._id.toHexString()}`);
	return { status: res.status, body: await res.json() };
}

// --- the audio URL ----------------------------------------------------------

/**
 * Skipped, deliberately, and they should stay in the file.
 *
 * These describe the intended behaviour: audio reached through the gated
 * endpoint rather than the bucket. Switching the payload to
 * media.playbackUrl() makes all three pass - and breaks playback. WaveSurfer
 * loads audio with fetch(), which defaults to credentials 'same-origin', so a
 * cross-origin request to api.* carries no session and the endpoint answers
 * 401. Confirmed in the browser: the media requests logged 401 while the same
 * page's /calls requests logged 304.
 *
 * So the payload change is only half of it. Finishing the job means either
 * teaching both players to authenticate (fetchParams credentials for
 * WaveSurfer, crossOrigin on the audio element) or serving audio from the
 * frontend's own origin so no credentials configuration is needed. Unskip these
 * as part of that change - they are the check that it worked.
 */
const PENDING_PLAYER_CREDENTIALS = {
	skip: "gated URL needs the players to send credentials - see the comment above"
};

describe("the audio URL handed to clients", () => {

	/**
	 * uploads.js writes objects with no ACL because they are meant to be
	 * reached through /:shortName/call/:id/media, which is behind
	 * requireListener and streams the bytes itself. If the payload carries the
	 * bucket URL instead, that gate is decorative: the object keys are
	 * predictable, so anyone who has or can guess one listens without an
	 * account. media.playbackUrl exists for exactly this and both builders have
	 * to use it.
	 */
	test("the list never leaks a bucket URL", PENDING_PLAYER_CREDENTIALS, async () => {
		const call = store(makeCall());

		const { body } = await getList();

		assert.equal(body.calls.length, 1);
		assert.equal(
			body.calls[0].url,
			`https://api.example.test/${SHORT_NAME}/call/${call._id.toHexString()}/media`
		);
		assert.notEqual(body.calls[0].url, call.url, "must not be the stored bucket URL");
	});

	test("a single call never leaks a bucket URL", PENDING_PLAYER_CREDENTIALS, async () => {
		const call = store(makeCall());

		const { body } = await getOne(call);

		assert.equal(
			body.call.url,
			`https://api.example.test/${SHORT_NAME}/call/${call._id.toHexString()}/media`
		);
		assert.notEqual(body.call.url, call.url, "must not be the stored bucket URL");
	});

	test("no field of either payload contains the object store host", PENDING_PLAYER_CREDENTIALS, async () => {
		const call = store(makeCall());

		const list = await getList();
		const one = await getOne(call);

		// Belt and braces: the URL is the field that matters, but nothing else
		// should be carrying the bucket address either.
		assert.equal(JSON.stringify(list.body).includes("media.example.test"), false);
		assert.equal(JSON.stringify(one.body).includes("media.example.test"), false);
	});
});

// --- the transcript gate ----------------------------------------------------

describe("who may read a transcript", () => {

	test("a Supporter gets the text", async () => {
		listener = { _id: new ObjectId(), plan: "supporter" };
		store(makeCall({ transcriptStatus: "done", transcript: { text: "net control this is n0call" } }));

		const { body } = await getList();

		assert.equal(body.calls[0].transcriptState, "ready");
		assert.equal(body.calls[0].transcript, "net control this is n0call");
	});

	test("a free account is told one exists but does not receive it", async () => {
		store(makeCall({ transcriptStatus: "done", transcript: { text: "net control this is n0call" } }));

		const { body } = await getList();

		assert.equal(body.calls[0].transcriptState, "locked");
		// Left out of the payload rather than sent and hidden in the browser.
		assert.equal(body.calls[0].transcript, undefined);
	});

	test("a call with no transcript reads the same to everyone", async () => {
		store(makeCall({ transcriptStatus: "none", transcript: null }));

		const free = await getList();
		listener = { _id: new ObjectId(), plan: "supporter" };
		const supporter = await getList();

		// Never dangle an upsell for a transcript that does not exist.
		assert.equal(free.body.calls[0].transcriptState, "none");
		assert.equal(supporter.body.calls[0].transcriptState, "none");
	});

	test("one still transcribing reads as pending only for a Supporter", async () => {
		store(makeCall({ transcriptStatus: "pending", transcript: null }));

		const free = await getList();
		listener = { _id: new ObjectId(), plan: "supporter" };
		const supporter = await getList();

		assert.equal(free.body.calls[0].transcriptState, "none");
		assert.equal(supporter.body.calls[0].transcriptState, "pending");
	});

	test("a signed-out visitor is treated as a free account", async () => {
		listener = null;
		store(makeCall({ transcriptStatus: "done", transcript: { text: "secret" } }));

		const { body } = await getList();

		assert.equal(body.calls[0].transcriptState, "locked");
		assert.equal(body.calls[0].transcript, undefined);
	});
});

// --- stars ------------------------------------------------------------------

describe("the star flag", () => {

	test("is false when this listener has not starred the call", async () => {
		store(makeCall());

		const { body } = await getList();

		assert.equal(body.calls[0].star, false);
	});

	test("is true when this listener has starred it", async () => {
		const call = store(makeCall());
		starredIds = [call._id];

		const list = await getList();
		const one = await getOne(call);

		// A call opened by link shows the same state as it does in the list.
		assert.equal(list.body.calls[0].star, true);
		assert.equal(one.body.call.star, true);
	});
});

// --- the two payload shapes -------------------------------------------------

describe("the shape of each payload", () => {

	// These two assertions exist to make the drift visible. They are the
	// current contract, not an endorsement of it: whoever unifies the builders
	// should expect these to fail and decide deliberately what the merged shape
	// is, rather than discovering the difference from a bug report.
	test("the list payload carries patches and not the display strings", async () => {
		store(makeCall());

		const { body } = await getList();
		const call = body.calls[0];

		assert.deepEqual(Object.keys(call).sort(), [
			"_id", "filename", "freq", "len", "patches", "srcList",
			"star", "talkgroupNum", "time", "transcriptState", "url"
		]);
	});

	test("the single-call payload carries the display strings and not patches", async () => {
		const call = store(makeCall());

		const { body } = await getOne(call);

		assert.deepEqual(Object.keys(body.call).sort(), [
			"_id", "dateString", "filename", "freq", "len", "name", "path",
			"shortName", "srcList", "star", "talkgroupNum", "time",
			"timeString", "transcriptState", "url"
		]);
	});

	test("length is rounded to whole seconds in both", async () => {
		const call = store(makeCall({ len: 10.79 }));

		const list = await getList();
		const one = await getOne(call);

		assert.equal(list.body.calls[0].len, 11);
		assert.equal(one.body.call.len, 11);
	});
});

// --- failure paths ----------------------------------------------------------

describe("the builders keep to themselves", () => {

	/**
	 * Both builders assigned `call = {...}` with no declaration, and calls.js has
	 * no "use strict", so each request wrote a module-level global. Harmless as
	 * written - the value is consumed immediately with nothing awaited in between
	 * - but it is one `await` away from two concurrent requests sharing a
	 * variable, and that failure looks like intermittently wrong data rather than
	 * an error.
	 */
	test("building a payload leaks nothing into global scope", async () => {
		delete globalThis.call;
		const call = store(makeCall());

		await getList();
		await getOne(call);

		assert.equal(globalThis.call, undefined, "`call` escaped into global scope");
	});
});

describe("asking for a call that is not there", () => {

	test("an unknown id is a 404, not a crash", async () => {
		const missing = makeCall();

		const { status, body } = await getOne(missing);

		assert.equal(status, 404);
		assert.equal(body.success, false);
	});

	test("a malformed id is rejected without reaching the database", async () => {
		let reached = false;
		const realFindById = Call.findById;
		Call.findById = (...args) => { reached = true; return realFindById(...args); };

		const res = await fetch(`${baseUrl}/${SHORT_NAME}/call/not-an-object-id`);
		const body = await res.json();
		Call.findById = realFindById;

		assert.equal(res.status, 500);
		assert.equal(body.success, false);
		assert.equal(reached, false, "should not query for an id it could not parse");
	});
});
