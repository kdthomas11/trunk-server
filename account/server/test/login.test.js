/**
 * Characterization tests for POST /login.
 *
 * Written against the behaviour as it exists today, not against how it ought to
 * work - the point is to pin down what sign-in currently does so a refactor that
 * changes it fails here instead of in production.
 *
 * Run inside the account container, where the runtime dependencies live:
 *
 *   docker exec -w /app hamrecorder-account-1 sh -c "node --test test/*.test.js"
 *
 * No test framework is involved. The runtime image is built with
 * `npm ci --omit=dev`, so a devDependency would simply not be installed there;
 * node's built-in runner and assert are always present.
 *
 * Mongo is the only thing faked. The real local strategy, the real passport
 * wiring, the real session middleware and the real handler all run - so the
 * things most likely to break in a refactor are the things actually exercised.
 */
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const LocalStrategy = require("passport-local").Strategy;
const bcrypt = require("bcrypt");

// Must be set before controllers/users.js is required: it constructs a Mailjet
// client at module load, and node-mailjet throws "Mailjet API_KEY is required"
// when the key is empty. Nothing here sends mail - these only need to be
// non-empty for the require to succeed. Conditional so a real environment wins.
//
// Without this the suite passes inside the container, where compose injects the
// real values from test.env, and fails everywhere else - a dependency on
// invisible external state, which is the thing that makes a suite untrustworthy.
process.env.MAILJET_KEY = process.env.MAILJET_KEY || "test-key";
process.env.MAILJET_SECRET = process.env.MAILJET_SECRET || "test-secret";

const User = require("../models/user");
const loginEvents = require("../controllers/login-events");
const configurePassport = require("../config/passport");
const users = require("../controllers/users");
const realLocalStrategy = require("../config/passport-strategies/local");

const PASSWORD = "correct-horse-battery";

/** A User document that was never saved - real schema, real comparePassword. */
function makeUser(overrides = {}) {
	const user = new User({
		email: "listener@example.com",
		callsign: "n0call",
		firstName: "Pat",
		lastName: "Listener",
		confirmEmail: true,
		disabled: false,
		plan: "free",
		terms: 1.1,
		...overrides
	});
	// Set directly rather than through the pre-save hook, which only runs on save().
	user.local.password = bcrypt.hashSync(PASSWORD, 8);
	return user;
}

// --- test doubles -----------------------------------------------------------

/** Rows loginEvents.record() was asked to write, newest last. */
let audit = [];
/** The account the faked Mongo will return, or null for "no such account". */
let storedUser = null;

let server;
let baseUrl;

before(async () => {
	// Mongo stand-in. findOne backs the strategy's lookup, findById backs
	// deserializeUser, updateOne backs the fire-and-forget lastLogin stamp.
	User.findOne = async () => storedUser;
	User.findById = () => ({ exec: async () => storedUser });
	User.updateOne = () => Promise.resolve({ acknowledged: true });

	// The audit trail is the behaviour under test in several cases below, not an
	// incidental collaborator, so it is observed rather than asserted blind.
	loginEvents.record = async (req, details) => { audit.push(details); };

	const app = express();
	app.use(express.json());
	app.use(session({
		secret: "test-only-secret",
		resave: false,
		saveUninitialized: false
	}));
	configurePassport(app, passport);
	app.use(passport.initialize());
	app.use(passport.session());

	// Mounted without limits.loginLimiter: the rate limiter is deliberately out
	// of scope here and would otherwise reject the later tests in this file.
	app.post("/login", users.login);

	await new Promise(resolve => { server = app.listen(0, resolve); });
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

beforeEach(() => {
	audit = [];
	storedUser = null;
	passport.use("local", realLocalStrategy);
});

/** POST /login, returning the parsed body and any session cookie. */
async function login(email, password) {
	const res = await fetch(`${baseUrl}/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password })
	});
	return { status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie") };
}

// --- the account cannot sign in --------------------------------------------

describe("POST /login - rejections", () => {

	test("an unconfirmed address is refused, and told which account to confirm", async () => {
		storedUser = makeUser({ confirmEmail: false });

		const { body } = await login("listener@example.com", PASSWORD);

		assert.equal(body.success, false);
		assert.equal(body.reason, "unconfirmed email");
		// The resend-confirmation flow acts on this id, so it has to come back.
		assert.equal(body.userId, storedUser.id);
	});

	test("a wrong password and an unknown address are indistinguishable", async () => {
		storedUser = makeUser();
		const wrongPassword = await login("listener@example.com", "not-the-password");

		storedUser = null;
		const noAccount = await login("nobody@example.com", PASSWORD);

		// Collapsed on purpose: telling these apart is how an attacker discovers
		// which addresses have accounts.
		assert.equal(wrongPassword.body.reason, "invalid");
		assert.equal(noAccount.body.reason, "invalid");
		assert.deepEqual(
			Object.keys(wrongPassword.body).sort(),
			Object.keys(noAccount.body).sort()
		);
		// Specifically no userId: returning one here would give away the same
		// thing the collapsed reason is hiding.
		assert.equal(wrongPassword.body.userId, undefined);
		assert.equal(noAccount.body.userId, undefined);
	});

	test("a disabled account is told it is disabled, not that it got the password wrong", async () => {
		storedUser = makeUser({ disabled: true });

		const { body } = await login("listener@example.com", PASSWORD);

		assert.equal(body.success, false);
		assert.equal(body.reason, "disabled");
	});

	test("the audit trail keeps the precise reason the client is not given", async () => {
		storedUser = makeUser();
		await login("listener@example.com", "not-the-password");

		assert.equal(audit.length, 1);
		assert.equal(audit[0].success, false);
		// The client saw "invalid"; the trail has to be able to tell a wrong
		// password on a real account apart from a guessed address.
		assert.equal(audit[0].reason, "bad password");
		assert.equal(audit[0].userId, storedUser.id);
	});

	test("no rejection records a successful login", async () => {
		const setups = [
			() => { storedUser = makeUser({ confirmEmail: false }); },
			() => { storedUser = makeUser({ disabled: true }); },
			() => { storedUser = null; }
		];
		for (const setup of setups) {
			audit = [];
			setup();
			await login("listener@example.com", PASSWORD);
			assert.equal(audit.some(row => row.success === true), false);
		}
	});
});

// --- the account can sign in ------------------------------------------------

describe("POST /login - success", () => {

	test("a confirmed account gets its profile and a session", async () => {
		storedUser = makeUser();

		const { body, cookie } = await login("listener@example.com", PASSWORD);

		assert.equal(body.success, true);
		assert.equal(body.userId, storedUser.id);
		assert.equal(body.user.callsign, "n0call");
		assert.equal(body.user.plan, "free");
		assert.ok(cookie, "a session cookie is set");
		// The password must not travel back to the client in any form.
		assert.equal(body.user.password, undefined);
		assert.equal(body.user.local, undefined);
	});

	test("a successful login is recorded as successful", async () => {
		storedUser = makeUser();

		await login("listener@example.com", PASSWORD);

		assert.equal(audit.length, 1);
		assert.equal(audit[0].success, true);
		assert.equal(audit[0].reason, "ok");
		assert.equal(audit[0].userId, storedUser.id);
	});
});

// --- defence in depth -------------------------------------------------------

describe("POST /login - the guard inside req.login()", () => {

	/**
	 * The strategy rejects unconfirmed accounts before it ever checks the
	 * password, so in the current wiring an unconfirmed user cannot reach
	 * req.login() - the guard inside it is defence in depth against a future
	 * change that moves or removes the strategy's check.
	 *
	 * This test replaces the strategy with one that hands back an unconfirmed
	 * user directly, which is the only way to exercise that branch. Before the
	 * missing `return` was added it fell through to the success path: the
	 * response was success:true carrying the full profile, and the attempt was
	 * recorded in the audit trail as a successful login.
	 */
	test("an unconfirmed user reaching req.login is refused, not signed in", async () => {
		const unconfirmed = makeUser({ confirmEmail: false });
		storedUser = unconfirmed;
		passport.use("local", new LocalStrategy(
			{ usernameField: "email" },
			(email, password, done) => done(null, unconfirmed)
		));

		const { body } = await login("listener@example.com", PASSWORD);

		assert.equal(body.success, false, "must not report success");
		assert.equal(body.reason, "unconfirmed email");
		assert.equal(body.user, undefined, "must not hand back the profile");
		assert.equal(audit.some(row => row.success === true), false,
			"must not record a successful login");
	});
});
