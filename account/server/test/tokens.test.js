/**
 * Tests for the confirm-email and reset-password token paths.
 *
 *   docker exec -w /app hamrecorder-account-1 node test/run.js
 *
 * Three things were wrong here and all three are the kind that stay wrong
 * quietly:
 *
 *  - Both handlers logged the token held in the database on a mismatch. A reset
 *    token is a full account takeover and is valid for a day; logs go to syslog
 *    and are kept.
 *  - The expiry check was `user.resetPasswordTTL < today`. With the field unset
 *    that is `undefined < today`, which is false - so the check passed. Nothing
 *    got through, because the token comparison after it rejected an unset token,
 *    but the expiry check was resting on the next check rather than doing its
 *    own job.
 *  - A successful reset cleared the token and left the TTL set, leaving the
 *    account in a "live TTL, empty token" state for the rest of the day.
 *
 * Mongo and Mailjet are faked. The real handlers run.
 */
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

// See login.test.js - node-mailjet throws at require time without these.
process.env.MAILJET_KEY = process.env.MAILJET_KEY || "test-key";
process.env.MAILJET_SECRET = process.env.MAILJET_SECRET || "test-secret";

const Mailjet = require("node-mailjet");
/** Every message a handler tried to send. */
let sentMessages = [];
Mailjet.prototype.post = function () {
	return {
		request: (payload) => {
			sentMessages.push(payload);
			return Promise.resolve({ body: {} });
		}
	};
};

const User = require("../models/user");
const users = require("../controllers/users");

const USER_ID = "507f1f77bcf86cd799439011";
const LIVE_TOKEN = "a".repeat(40);   // crypto.randomBytes(20).toString("hex")

/** The account the faked Mongo returns, or null. */
let storedUser = null;
/** Everything written to the console during a test. */
let logged = [];
/** What the handler saved, if anything. */
let saved = null;

let server;
let baseUrl;

const realWarn = console.warn;
const realError = console.error;
const realLog = console.log;

/** A plain object standing in for a User document. */
function makeUser(overrides = {}) {
	const user = {
		id: USER_ID,
		_id: USER_ID,
		email: "listener@example.com",
		firstName: "Pat",
		lastName: "Listener",
		confirmEmail: false,
		confirmEmailToken: LIVE_TOKEN,
		confirmEmailTTL: tomorrow(),
		resetPasswordToken: LIVE_TOKEN,
		resetPasswordTTL: tomorrow(),
		save: async function () { saved = this; return this; },
		...overrides
	};
	return user;
}

function tomorrow() {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	return d;
}

function yesterday() {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return d;
}

before(async () => {
	User.findById = async () => storedUser;
	User.findOne = async () => storedUser;

	const app = express();
	app.use(express.json());
	app.post("/users/:userId/confirm/:token", users.confirmEmail);
	app.post("/users/:userId/reset-password/:token", users.resetPassword);
	app.post("/api/send-reset-password", users.sendResetPassword);

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
	logged = [];
	saved = null;
	storedUser = makeUser();

	const capture = (...args) => { logged.push(args.map(String).join(" ")); };
	console.warn = capture;
	console.error = capture;
	console.log = capture;
});

async function confirm(token) {
	const res = await fetch(`${baseUrl}/users/${USER_ID}/confirm/${token}`, { method: "POST" });
	return { status: res.status, body: await res.json() };
}

async function reset(token, password = "new-password-here") {
	const res = await fetch(`${baseUrl}/users/${USER_ID}/reset-password/${token}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password })
	});
	return { status: res.status, body: await res.json() };
}

/** Asserts no log line written during this test contains the token. */
function assertTokenNotLogged(token) {
	assert.ok(logged.length > 0, "the mismatch should still be logged");
	for (const line of logged) {
		assert.ok(!line.includes(token), `a token leaked into a log line: ${line}`);
	}
}

// --- reset password ---------------------------------------------------------

describe("reset password", () => {

	test("the live token is accepted and the password is set", async () => {
		const { status, body } = await reset(LIVE_TOKEN);

		assert.equal(status, 200);
		assert.equal(body.success, true);
		assert.equal(saved.password, "new-password-here");
	});

	test("a wrong token of the same length is refused", async () => {
		const { status, body } = await reset("b".repeat(40));

		assert.equal(status, 400);
		assert.equal(body.message, "token mismatch");
		assert.equal(saved, null, "nothing may be saved for a bad token");
	});

	test("a wrong token of a different length is refused, not thrown", async () => {
		// timingSafeEqual throws on mismatched lengths, so the length check has
		// to come first or this is a 500 with a stack trace.
		const { status } = await reset("short");

		assert.equal(status, 400);
		assert.equal(saved, null);
	});

	/**
	 * The one that mattered. This used to print the token currently valid in the
	 * database, which is a 24-hour account takeover sitting in syslog.
	 */
	test("neither the submitted nor the stored token is logged", async () => {
		const submitted = "c".repeat(40);

		await reset(submitted);

		assertTokenNotLogged(LIVE_TOKEN);
		assertTokenNotLogged(submitted);
	});

	test("an expired token is refused", async () => {
		storedUser.resetPasswordTTL = yesterday();

		const { status, body } = await reset(LIVE_TOKEN);

		assert.equal(status, 400);
		assert.equal(body.message, "token expired");
		assert.equal(saved, null);
	});

	/**
	 * `undefined < today` is false, so an unset TTL used to pass the expiry
	 * check and leave the token comparison as the only thing standing there.
	 */
	test("an unset TTL is treated as expired, not as valid", async () => {
		storedUser.resetPasswordTTL = undefined;

		const { status, body } = await reset(LIVE_TOKEN);

		assert.equal(status, 400);
		assert.equal(body.message, "token expired");
		assert.equal(saved, null);
	});

	/**
	 * A completed reset sets the stored token to "" rather than removing it. An
	 * empty submitted token must never match that.
	 */
	test("an empty stored token cannot be matched", async () => {
		storedUser.resetPasswordToken = "";

		const { status } = await reset("d".repeat(40));

		assert.equal(status, 400);
		assert.equal(saved, null);
	});

	test("a successful reset clears the TTL as well as the token", async () => {
		await reset(LIVE_TOKEN);

		assert.equal(saved.resetPasswordToken, "");
		assert.ok(!saved.resetPasswordTTL, "the TTL must not outlive the token it guarded");
	});
});

// --- confirm email ----------------------------------------------------------

describe("confirm email", () => {

	test("the live token confirms the address", async () => {
		const { status, body } = await confirm(LIVE_TOKEN);

		assert.equal(status, 200);
		assert.equal(body.success, true);
		assert.equal(saved.confirmEmail, true);
	});

	test("a wrong token is refused", async () => {
		const { status, body } = await confirm("b".repeat(40));

		assert.equal(status, 400);
		assert.equal(body.message, "token mismatch");
		assert.equal(saved, null);
	});

	test("neither token is logged on a mismatch", async () => {
		const submitted = "e".repeat(40);

		await confirm(submitted);

		assertTokenNotLogged(LIVE_TOKEN);
		assertTokenNotLogged(submitted);
	});

	test("an unset TTL is treated as expired", async () => {
		storedUser.confirmEmailTTL = undefined;

		const { status, body } = await confirm(LIVE_TOKEN);

		assert.equal(status, 400);
		assert.equal(body.message, "token expired");
		assert.equal(saved, null);
	});
});

// --- user enumeration -------------------------------------------------------

describe("send reset password", () => {

	async function send(email) {
		const res = await fetch(`${baseUrl}/api/send-reset-password`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email })
		});
		return { status: res.status, body: await res.json() };
	}

	/**
	 * This answered 404 "No account register for X" for an address with no
	 * account, and 200 for one with an account - a free check of whether any
	 * given email is registered here. The two answers have to be identical.
	 */
	test("an unknown address gets the same answer as a known one", async () => {
		storedUser = makeUser();
		const known = await send("listener@example.com");

		storedUser = null;
		const unknown = await send("nobody@example.com");

		assert.equal(unknown.status, known.status, "the status must not distinguish them");
		assert.deepEqual(unknown.body, known.body, "the body must not distinguish them");
	});

	test("no mail is sent for an address with no account", async () => {
		storedUser = null;

		await send("nobody@example.com");

		assert.deepEqual(sentMessages, []);
	});

	test("mail is still sent for an address that does have an account", async () => {
		storedUser = makeUser();

		await send("listener@example.com");

		assert.equal(sentMessages.length, 1);
	});
});
