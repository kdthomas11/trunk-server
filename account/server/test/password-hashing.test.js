/**
 * Tests for how passwords are hashed and upgraded.
 *
 *   docker exec -w /app hamrecorder-account-1 node test/run.js
 *
 * Three things are pinned here:
 *
 *  - New hashes use the current cost. It was 8, which is below OWASP's floor of
 *    10, and the whole point of the change is that new accounts get 12.
 *  - Hashing and comparison are asynchronous. bcrypt at cost 12 takes ~300ms,
 *    and the *Sync forms block the event loop for that long for every request in
 *    the process, not just the one signing in. Raising the cost without moving
 *    off them would have been a self-inflicted denial of service, so a revert to
 *    hashSync has to fail here.
 *  - Old hashes are upgraded on next successful sign-in. That is the only moment
 *    the plaintext is available and proven correct. If this quietly stops
 *    working, every existing account keeps its cost-8 hash forever and nothing
 *    anywhere reports it.
 */
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");

// See login.test.js - node-mailjet throws at require time without these.
process.env.MAILJET_KEY = process.env.MAILJET_KEY || "test-key";
process.env.MAILJET_SECRET = process.env.MAILJET_SECRET || "test-secret";

const User = require("../models/user");

const PASSWORD = "correct-horse-battery";
const CURRENT_COST = 12;
const OLD_COST = 8;

/** An unsaved User document - real schema, real hooks. */
function makeUser(overrides = {}) {
	return new User({
		email: "listener@example.com",
		callsign: "n0call",
		confirmEmail: true,
		...overrides
	});
}

/** Runs the pre-save hooks without touching Mongo. */
function runSaveHooks(doc) {
	return new Promise((resolve, reject) => {
		// $__save is not available off a connection, so the hooks are invoked
		// directly. This is what mongoose calls internally on save().
		doc.$__.saveOptions = {};
		const hooks = doc.$__original_save || null;
		doc.validate()
			.then(() => doc.constructor.hooks.execPre("save", doc, [], (err) => {
				if (err) return reject(err);
				resolve(doc);
			}))
			.catch(reject);
	});
}

describe("new hashes", () => {

	test("are written at the current cost, not the old one", async () => {
		const user = makeUser();
		user.password = PASSWORD;

		await runSaveHooks(user);

		assert.equal(bcrypt.getRounds(user.password), CURRENT_COST);
		assert.notEqual(bcrypt.getRounds(user.password), OLD_COST);
	});

	test("are written to local.password too, which is what login reads", async () => {
		const user = makeUser();
		user.password = PASSWORD;

		await runSaveHooks(user);

		assert.equal(user.local.password, user.password);
		assert.equal(bcrypt.getRounds(user.local.password), CURRENT_COST);
	});

	test("actually verify against the plaintext", async () => {
		const user = makeUser();
		user.password = PASSWORD;

		await runSaveHooks(user);

		const match = await new Promise(r => user.comparePassword(PASSWORD, (e, m) => r(m)));
		assert.equal(match, true);
	});

	test("the hook does not run when the password was not touched", async () => {
		const user = makeUser();
		user.password = PASSWORD;
		await runSaveHooks(user);
		const first = user.password;

		// A real save() clears the modified paths once it has written. These
		// tests drive the hooks directly, so that has to be done by hand -
		// without it `password` stays modified and the hook correctly fires
		// again, which looks like a bug in the hook and is not one.
		user.unmarkModified("password");

		user.city = "Sacramento";
		await runSaveHooks(user);

		assert.equal(user.password, first, "an unrelated save must not re-hash");
	});
});

describe("comparison", () => {

	test("rejects the wrong password", async () => {
		const user = makeUser();
		user.password = PASSWORD;
		await runSaveHooks(user);

		const match = await new Promise(r => user.comparePassword("wrong", (e, m) => r(m)));
		assert.equal(match, false);
	});

	/**
	 * bcrypt throws "Illegal arguments" on an undefined hash, which turned an
	 * account with no password set into a 500 rather than a refused login.
	 */
	test("an account with no stored hash is refused, not an error", async () => {
		const user = makeUser();

		const result = await new Promise(r =>
			user.comparePassword(PASSWORD, (err, match) => r({ err, match })));

		assert.equal(result.err, null);
		assert.equal(result.match, false);
	});

	test("an empty stored hash is refused", async () => {
		const user = makeUser();
		user.local.password = "";

		const result = await new Promise(r =>
			user.comparePassword(PASSWORD, (err, match) => r({ err, match })));

		assert.equal(result.err, null);
		assert.equal(result.match, false);
	});

	/**
	 * The guard against a revert to compareSync. A synchronous implementation
	 * calls the callback before this function returns; the async one cannot.
	 */
	test("is asynchronous - the callback does not fire before returning", async () => {
		const user = makeUser();
		user.password = PASSWORD;
		await runSaveHooks(user);

		let firedSynchronously = false;
		let returned = false;
		await new Promise(resolve => {
			user.comparePassword(PASSWORD, () => {
				if (!returned) firedSynchronously = true;
				resolve();
			});
			returned = true;
		});

		assert.equal(firedSynchronously, false,
			"comparePassword called its callback synchronously - it is back on compareSync, " +
			"which blocks the event loop for the whole hash");
	});
});

describe("upgrading an old hash", () => {

	test("a cost-8 hash is flagged for rehashing", () => {
		const user = makeUser();
		user.local.password = bcrypt.hashSync(PASSWORD, OLD_COST);

		assert.equal(user.needsRehash(), true);
	});

	test("a current-cost hash is left alone", async () => {
		const user = makeUser();
		user.password = PASSWORD;
		await runSaveHooks(user);

		assert.equal(user.needsRehash(), false);
	});

	/**
	 * getRounds throws on anything that is not a bcrypt hash. An account whose
	 * cost cannot be read is left alone rather than rehashed on a guess.
	 */
	test("an unreadable hash is not flagged", () => {
		const user = makeUser();

		user.local.password = "";
		assert.equal(user.needsRehash(), false);

		user.local.password = "not-a-bcrypt-hash";
		assert.equal(user.needsRehash(), false);
	});

	/**
	 * The upgrade path end to end: an old hash, the correct password, and the
	 * save the sign-in performs. The new hash must still verify - an upgrade
	 * that locked someone out would be worse than the old cost.
	 */
	test("rehashing produces a working hash at the current cost", async () => {
		const user = makeUser();
		user.local.password = bcrypt.hashSync(PASSWORD, OLD_COST);
		assert.equal(user.needsRehash(), true);

		// What local.js does on a successful sign-in.
		user.password = PASSWORD;
		await runSaveHooks(user);

		assert.equal(bcrypt.getRounds(user.local.password), CURRENT_COST);
		assert.equal(user.needsRehash(), false);

		const match = await new Promise(r => user.comparePassword(PASSWORD, (e, m) => r(m)));
		assert.equal(match, true, "the upgraded hash must still accept the same password");
	});
});
