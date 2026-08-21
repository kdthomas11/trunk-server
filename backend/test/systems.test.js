/**
 * Tests for the two endpoints on the backend that anyone could reach.
 *
 *   docker exec -w /home/app hamrecorder-backend-1 node test/run.js
 *
 * POST /:shortName/contact sent mail through our Mailjet account to the system
 * owner and the admin address, with no session, no rate limit and no length cap
 * on any field. POST /:shortName/authorize answered whether a system API key
 * was valid, unlimited and as fast as you could ask, and logged every key it was
 * given.
 *
 * These pin the three things that fix depends on and that are easy to undo by
 * accident: the listener gate on contact, the input caps, and that neither
 * handler writes a credential to the log.
 *
 * Mongo, Mailjet and node-schedule are faked. The real handlers and the real
 * validation run.
 */
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { ObjectId } = require("mongodb");

// --- stubs that must be in place before the controller is required ----------

// systems.js calls load_systems() and schedule.scheduleJob() at module load.
// The cron job holds an active timer, which would keep `node --test` alive
// forever, and load_systems() would sit waiting on a Mongo connection that does
// not exist in a unit test.
const schedule = require("node-schedule");
schedule.scheduleJob = () => ({ cancel() {} });

// The controller builds its Mailjet client at module load, so the only place to
// intercept is the prototype. Anything that reaches this in a test is a message
// we would really have sent.
const Mailjet = require("node-mailjet");
/** Every message the handler tried to send. */
let sentMessages = [];
/** Set to make the send reject, as Mailjet would on a bad request. */
let sendFails = false;
Mailjet.prototype.post = function () {
	return {
		request: (payload) => {
			sentMessages.push(payload);
			return sendFails
				? Promise.reject({ statusCode: 400 })
				: Promise.resolve({ body: {} });
		}
	};
};

const System = require("../models/system");
const User = require("../models/user");

// load_systems() runs on require and needs these to resolve.
System.find = () => ({ populate: async () => [] });

const systems = require("../controllers/systems");
const { keysMatch } = require("../middleware/auth");
const { requireListener } = require("../middleware/auth");

// --- fakes ------------------------------------------------------------------

const SHORT_NAME = "2msac";
const REAL_KEY = "0123456789abcdef0123456789abcdef";

/** The system findOne will return, or null. */
let storedSystem = null;
/** The owner findById will return, or null. */
let storedOwner = null;
/** Everything written to console.warn / console.error during a test. */
let logged = [];

let server;
let baseUrl;
/** Set per-test; becomes req.listener when the gate is satisfied. */
let listener = null;

const realWarn = console.warn;
const realError = console.error;
const realLog = console.log;

before(async () => {
	System.findOne = async () => storedSystem;
	User.findById = () => ({ exec: async () => storedOwner });

	const app = express();
	app.use(express.json());
	app.use(express.urlencoded({ extended: true }));

	// Stands in for the session the account service would have issued. Setting
	// req.session is what requireListener actually reads, so the real gate runs.
	app.use((req, res, next) => {
		if (listener) req.session = { passport: { user: listener._id } };
		next();
	});

	app.post("/:shortName/contact", requireListener, systems.contact_system);
	app.post("/:shortName/authorize", systems.authorize_system);

	await new Promise(resolve => { server = app.listen(0, resolve); });
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
	console.warn = realWarn;
	console.error = realError;
	console.log = realLog;
	if (server) server.close();
});

beforeEach(() => {
	sentMessages = [];
	sendFails = false;
	logged = [];
	listener = null;
	storedSystem = {
		shortName: SHORT_NAME,
		name: "2 Meter SAC",
		allowContact: true,
		userId: new ObjectId(),
		key: REAL_KEY
	};
	storedOwner = {
		_id: storedSystem.userId,
		email: "owner@example.test",
		firstName: "Ada",
		lastName: "Lovelace",
		confirmEmail: true,
		disabled: false,
		plan: "free"
	};

	const capture = (...args) => { logged.push(args.join(" ")); };
	console.warn = capture;
	console.error = capture;
	console.log = capture;
});

/** Makes requireListener resolve to a real listener. */
function signIn() {
	const id = new ObjectId();
	listener = { _id: id };
	// Two different call shapes share this model. requireListener awaits
	// User.findById(id, projection) directly, so that needs a thenable;
	// contact_system calls User.findById(ownerId).exec(), so that needs a query
	// object. The projection argument is what tells them apart.
	User.findById = (wanted, projection) => {
		if (projection) {
			return Promise.resolve({
				_id: id, confirmEmail: true, disabled: false, plan: "free"
			});
		}
		return { exec: async () => storedOwner };
	};
	return id;
}

async function postContact(body) {
	const res = await fetch(`${baseUrl}/${SHORT_NAME}/contact`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body)
	});
	return { status: res.status, body: await res.json() };
}

async function postAuthorize(api_key) {
	const res = await fetch(`${baseUrl}/${SHORT_NAME}/authorize`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ api_key })
	});
	return { status: res.status, text: await res.text() };
}

const VALID = { name: "Ken", email: "ken@example.test", message: "Your feed is down." };

// --- the listener gate ------------------------------------------------------

describe("contact requires a signed-in listener", () => {

	/**
	 * The whole point of the fix. Without a session this endpoint let anyone on
	 * the internet push mail through our Mailjet account, to the system owner and
	 * to the admin address, as often as they liked. Suspension there also takes
	 * out password reset and email confirmation, which go through the same
	 * account.
	 */
	test("a caller with no session is refused and no mail is sent", async () => {
		const { status } = await postContact(VALID);

		assert.equal(status, 401);
		assert.deepEqual(sentMessages, [], "nothing may be sent for an unauthenticated caller");
	});

	test("a signed-in listener gets through", async () => {
		signIn();

		const { status, body } = await postContact(VALID);

		assert.equal(status, 200);
		assert.equal(body.success, true);
		assert.equal(sentMessages.length, 1);
	});
});

// --- input validation -------------------------------------------------------

describe("contact input caps", () => {

	beforeEach(() => { signIn(); });

	test("a message longer than the cap is refused", async () => {
		const { status, body } = await postContact({ ...VALID, message: "x".repeat(2001) });

		assert.equal(status, 400);
		assert.equal(body.success, false);
		assert.deepEqual(sentMessages, []);
	});

	test("a message at the cap is accepted", async () => {
		const { status } = await postContact({ ...VALID, message: "x".repeat(2000) });

		assert.equal(status, 200);
		assert.equal(sentMessages.length, 1);
	});

	test("an over-long name is refused", async () => {
		const { status } = await postContact({ ...VALID, name: "x".repeat(101) });

		assert.equal(status, 400);
		assert.deepEqual(sentMessages, []);
	});

	test("each field is required", async () => {
		for (const missing of ["name", "email", "message"]) {
			const body = { ...VALID };
			delete body[missing];

			const { status } = await postContact(body);

			assert.equal(status, 400, `${missing} must be required`);
		}
		assert.deepEqual(sentMessages, []);
	});

	test("whitespace alone does not count as a field", async () => {
		const { status } = await postContact({ ...VALID, message: "   \n\t  " });

		assert.equal(status, 400);
		assert.deepEqual(sentMessages, []);
	});

	/**
	 * A field that is not a string used to reach the mail template as whatever it
	 * was - an array, an object - because nothing checked the type.
	 */
	test("a non-string field is refused", async () => {
		const { status } = await postContact({ ...VALID, name: ["a", "b"] });

		assert.equal(status, 400);
		assert.deepEqual(sentMessages, []);
	});

	/**
	 * The address goes into a ReplyTo header. Mailjet's JSON API is not raw SMTP,
	 * so a newline here was never going to inject a header on its own - but there
	 * is no reason to carry one that far.
	 */
	test("an address containing a newline is refused", async () => {
		const { status } = await postContact({
			...VALID,
			email: "ken@example.test\nBcc: victim@example.test"
		});

		assert.equal(status, 400);
		assert.deepEqual(sentMessages, []);
	});

	test("an address with no @ is refused", async () => {
		const { status } = await postContact({ ...VALID, email: "not-an-address" });

		assert.equal(status, 400);
		assert.deepEqual(sentMessages, []);
	});
});

// --- what actually gets sent ------------------------------------------------

describe("the message that goes out", () => {

	beforeEach(() => { signIn(); });

	test("ReplyTo carries the trimmed sender, not the raw body", async () => {
		await postContact({ ...VALID, name: "  Ken  ", email: "  ken@example.test  " });

		const reply = sentMessages[0].Messages[0].ReplyTo;
		assert.equal(reply.Email, "ken@example.test");
		assert.equal(reply.Name, "Ken");
	});

	/**
	 * This site is not OpenMHz. The body said so for every message it sent.
	 */
	test("the body does not name the upstream project", async () => {
		await postContact(VALID);

		assert.ok(
			!sentMessages[0].Messages[0].TextPart.includes("OpenMHz"),
			"the contact email must not say OpenMHz"
		);
	});

	/**
	 * 403, not 500. The request was understood and is refused - this is the
	 * owner's setting, not a fault on our side, and answering 500 buried it
	 * among real errors in the log.
	 */
	test("a system that has not opted in is refused, not contacted", async () => {
		storedSystem.allowContact = false;

		const { status } = await postContact(VALID);

		assert.equal(status, 403);
		assert.deepEqual(sentMessages, []);
	});

	test("an unknown system is a 404", async () => {
		storedSystem = null;

		const { status } = await postContact(VALID);

		assert.equal(status, 404);
		assert.deepEqual(sentMessages, []);
	});
});

// --- the authorize oracle ---------------------------------------------------

describe("authorize", () => {

	test("the right key is accepted", async () => {
		const { status } = await postAuthorize(REAL_KEY);

		assert.equal(status, 200);
	});

	test("a wrong key of the same length is refused", async () => {
		const { status } = await postAuthorize("f".repeat(REAL_KEY.length));

		assert.equal(status, 403);
	});

	test("a wrong key of a different length is refused, not thrown", async () => {
		// timingSafeEqual throws unless both buffers are the same length, so the
		// length check in keysMatch has to come first or this is a 500.
		const { status } = await postAuthorize("short");

		assert.equal(status, 403);
	});

	test("a missing key is refused", async () => {
		const { status } = await postAuthorize(undefined);

		assert.equal(status, 403);
	});

	/**
	 * Logs go to syslog and are kept. Printing the submitted key turned every
	 * mistyped trunk-recorder config into a durable record of a credential.
	 */
	test("a rejected key is never written to the log", async () => {
		const secret = "deadbeefdeadbeefdeadbeefdeadbeef";

		await postAuthorize(secret);

		assert.ok(logged.length > 0, "the mismatch should still be logged");
		for (const line of logged) {
			assert.ok(!line.includes(secret), `the key leaked into a log line: ${line}`);
		}
	});
});

// --- the real route table ---------------------------------------------------

/**
 * Everything above mounts the handlers on an app this file builds, which proves
 * requireListener and contact_system work together but not that index.js
 * actually wires them that way. Removing the gate from the real route table
 * would leave every test above green.
 *
 * Reading the source is a blunt way to check that, and it is the only one
 * available without starting index.js - which connects to Mongo, opens a socket
 * server and schedules a nightly job on require. The routes are one line each
 * and change rarely, so a string check is worth more here than the machinery to
 * do it properly.
 */
describe("the routes index.js actually registers", () => {

	const fs = require("node:fs");
	const path = require("node:path");
	const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

	/** The registration line for a route, comments stripped. */
	function routeLine(method, route) {
		const line = source
			.split("\n")
			.find(l => l.trim().startsWith(`app.${method}('${route}'`));
		assert.ok(line, `no ${method.toUpperCase()} ${route} route found in index.js`);
		return line;
	}

	test("contact is behind requireListener and the rate limiter", () => {
		const line = routeLine("post", "/:shortName/contact");

		assert.ok(line.includes("requireListener"), `contact lost its gate: ${line}`);
		assert.ok(line.includes("contactLimiter"), `contact lost its limiter: ${line}`);
	});

	/**
	 * Cannot take a session - trunk-recorder has no cookie to offer - so the
	 * limiter is the only brake in the application.
	 */
	test("authorize is rate limited", () => {
		const line = routeLine("post", "/:shortName/authorize");

		assert.ok(line.includes("authorizeLimiter"), `authorize lost its limiter: ${line}`);
	});

	/**
	 * These returned a row per connected socket - which system each listener was
	 * on, their talkgroup filter - to anyone who asked, and nothing called them.
	 * /stats is the one the front page uses and stays public.
	 */
	test("the per-socket clients endpoints are gone", () => {
		assert.ok(!source.includes("app.get('/clients'"), "/clients came back");
		assert.ok(!source.includes("app.get('/:shortName/clients'"), "/:shortName/clients came back");
		assert.ok(!/function get_clients/.test(source), "get_clients came back");
	});

	test("every route that serves call content still requires a listener", () => {
		const callRoutes = source
			.split("\n")
			.filter(l => /^app\.(get|post)\('\/(:shortName\/)?(call|calls|card|add_star|remove_star)/.test(l.trim()));

		assert.ok(callRoutes.length >= 8, `expected the call routes, found ${callRoutes.length}`);
		for (const line of callRoutes) {
			assert.ok(line.includes("requireListener"), `ungated call route: ${line}`);
		}
	});
});

// --- the comparison itself --------------------------------------------------

describe("keysMatch", () => {

	test("equal keys match", () => {
		assert.equal(keysMatch(REAL_KEY, REAL_KEY), true);
	});

	test("different keys of equal length do not match", () => {
		assert.equal(keysMatch("a".repeat(32), "b".repeat(32)), false);
	});

	test("a difference in the last byte is caught", () => {
		const almost = REAL_KEY.slice(0, -1) + (REAL_KEY.endsWith("f") ? "e" : "f");
		assert.equal(keysMatch(almost, REAL_KEY), false);
	});

	test("different lengths do not match and do not throw", () => {
		assert.equal(keysMatch("abc", REAL_KEY), false);
		assert.equal(keysMatch(REAL_KEY, "abc"), false);
	});

	test("non-strings do not match", () => {
		assert.equal(keysMatch(undefined, REAL_KEY), false);
		assert.equal(keysMatch(null, REAL_KEY), false);
		assert.equal(keysMatch(REAL_KEY, undefined), false);
		assert.equal(keysMatch({}, REAL_KEY), false);
	});

	/**
	 * Both empty is the case that matters: a system whose key was never set must
	 * not be openable by sending an empty key.
	 */
	test("two empty strings do not match", () => {
		assert.equal(keysMatch("", ""), false);
	});
});
