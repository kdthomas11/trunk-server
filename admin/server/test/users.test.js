/**
 * Characterization tests for admin account administration.
 *
 *   docker exec -w /app hamrecorder-admin-1 node test/run.js
 *
 * These are the routes that can disable somebody's account, grant a paid plan,
 * or delete an account outright, and until now nothing checked any of them.
 *
 * Written against the behaviour as it exists today, including one asymmetry
 * that looks like an oversight and is not: an admin may not change their own
 * admin flag or disable themselves, but may grant themselves Supporter. The
 * controller says so in a comment, and there is a test below that pins it, so
 * that "fixing the inconsistency" fails here rather than quietly removing the
 * only practical way to exercise the paid tier.
 *
 * Mongo is the only thing faked. The real handlers, the real guards and the
 * real User schema all run.
 */
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");

const users = require("../controllers/users");
const User = require("../models/user");
const System = require("../models/system");

const ObjectId = mongoose.Types.ObjectId;

/** The admin performing the action. */
let actingAdmin;
/** The account being acted on, or null for "no such account". */
let target = null;
/** How many systems the target owns. */
let systemCount = 0;
/** The projection updateUser asked for when re-reading the account. */
let requestedProjection = null;
/** Ids passed to User.deleteOne. */
let deleted = [];

let server;
let baseUrl;

/** A User document that was never saved, with save() stubbed out. */
function makeUser(overrides = {}) {
	const user = new User({
		email: "listener@example.com",
		callsign: "n0call",
		confirmEmail: true,
		admin: false,
		disabled: false,
		plan: "free",
		...overrides
	});
	user.save = async () => user;
	return user;
}

before(async () => {
	// findById is called two ways: bare, to load the document to mutate, and
	// with a projection plus .lean(), to build the response.
	User.findById = (id, fields) => {
		if (fields) {
			requestedProjection = fields;
			return { lean: async () => (target ? target.toObject() : null) };
		}
		return Promise.resolve(target);
	};
	User.deleteOne = async (filter) => { deleted.push(filter._id); return { deletedCount: 1 }; };
	System.countDocuments = async () => systemCount;

	const app = express();
	app.use(express.json());
	// Stands in for isAdmin, which the real routes are gated by. The guards
	// under test here are the ones inside the handlers, not the gate itself.
	app.use((req, res, next) => { req.user = actingAdmin; next(); });
	app.post("/admin/user-accounts/:userId", users.updateUser);
	app.delete("/admin/user-accounts/:userId", users.deleteUser);

	await new Promise(resolve => { server = app.listen(0, resolve); });
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

beforeEach(() => {
	actingAdmin = { _id: new ObjectId(), email: "admin@example.com", admin: true };
	target = null;
	systemCount = 0;
	requestedProjection = null;
	deleted = [];
});

async function update(userId, body) {
	const res = await fetch(`${baseUrl}/admin/user-accounts/${userId}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body)
	});
	return { status: res.status, body: await res.json() };
}

async function remove(userId) {
	const res = await fetch(`${baseUrl}/admin/user-accounts/${userId}`, { method: "DELETE" });
	return { status: res.status, body: await res.json() };
}

// --- guards that stop an admin locking themselves out -----------------------

describe("acting on your own account", () => {

	test("an admin cannot remove their own admin access", async () => {
		target = makeUser({ admin: true });
		target._id = actingAdmin._id;

		const { status, body } = await update(target._id, { admin: false });

		assert.equal(status, 400);
		assert.equal(body.success, false);
		// The point of the guard: the last admin cannot lock everyone out.
		assert.equal(target.admin, true, "the flag must be left alone");
	});

	test("an admin cannot disable their own account", async () => {
		target = makeUser({ admin: true });
		target._id = actingAdmin._id;

		const { status, body } = await update(target._id, { disabled: true });

		assert.equal(status, 400);
		assert.equal(body.success, false);
		assert.equal(target.disabled, false);
	});

	test("an admin cannot delete their own account", async () => {
		target = makeUser({ admin: true });
		target._id = actingAdmin._id;

		const { status, body } = await remove(target._id);

		assert.equal(status, 400);
		assert.equal(body.success, false);
		assert.deepEqual(deleted, [], "nothing should have been deleted");
	});

	/**
	 * Deliberately allowed. The other two guards exist to stop an operator
	 * locking themselves out of the portal; neither risk applies to a plan, and
	 * granting yourself Supporter is how the paid tier gets exercised at all.
	 * If this test starts failing because someone made the three consistent,
	 * the fix is to revert that, not to change this.
	 */
	test("an admin may grant themselves Supporter", async () => {
		target = makeUser();
		target._id = actingAdmin._id;

		const { status, body } = await update(target._id, { plan: "supporter" });

		assert.equal(status, 200);
		assert.equal(body.success, true);
		assert.equal(target.plan, "supporter");
	});
});

// --- plans ------------------------------------------------------------------

describe("granting and removing a plan", () => {

	test("an unknown plan is refused", async () => {
		target = makeUser();

		const { status, body } = await update(target._id, { plan: "enterprise" });

		assert.equal(status, 400);
		assert.match(body.message, /enterprise/);
		assert.equal(target.plan, "free", "the plan must be left alone");
	});

	test("granting Supporter records who did it and when", async () => {
		target = makeUser();

		await update(target._id, { plan: "supporter" });

		assert.equal(target.plan, "supporter");
		assert.ok(target.planGrantedAt instanceof Date);
		// Once Supporter can be earned by subscription or donation, "why does
		// this account have it" becomes a real support question.
		assert.ok(target.planGrantedBy.equals(actingAdmin._id));
	});

	test("dropping back to free clears the grant record", async () => {
		target = makeUser({ plan: "supporter", planGrantedAt: new Date(), planGrantedBy: new ObjectId() });

		await update(target._id, { plan: "free" });

		assert.equal(target.plan, "free");
		assert.equal(target.planGrantedAt, undefined);
		assert.equal(target.planGrantedBy, undefined);
	});
});

// --- disabling --------------------------------------------------------------

describe("disabling an account", () => {

	test("disabling records when and why", async () => {
		target = makeUser();

		await update(target._id, { disabled: true, disabledReason: "spamming the contact form" });

		assert.equal(target.disabled, true);
		assert.ok(target.disabledAt instanceof Date);
		assert.equal(target.disabledReason, "spamming the contact form");
	});

	test("the reason is truncated rather than stored unbounded", async () => {
		target = makeUser();

		await update(target._id, { disabled: true, disabledReason: "x".repeat(500) });

		assert.equal(target.disabledReason.length, 200);
	});

	test("a missing reason is stored as empty, not undefined", async () => {
		target = makeUser();

		await update(target._id, { disabled: true });

		assert.equal(target.disabled, true);
		assert.equal(target.disabledReason, "");
	});

	test("re-enabling clears the disable record", async () => {
		target = makeUser({ disabled: true, disabledAt: new Date(), disabledReason: "spamming" });

		await update(target._id, { disabled: false });

		assert.equal(target.disabled, false);
		assert.equal(target.disabledAt, undefined);
		assert.equal(target.disabledReason, undefined);
	});
});

// --- what comes back --------------------------------------------------------

describe("the account returned to the browser", () => {

	test("is read through a projection that excludes secrets", async () => {
		target = makeUser();

		await update(target._id, { plan: "supporter" });

		// Asserting the projection rather than the response body: the body is
		// whatever the fake returns, but the projection is the code's own
		// decision and the thing that would leak if someone widened it.
		assert.ok(requestedProjection, "the response must be re-read through a projection");
		for (const secret of ["password", "resetPasswordToken", "confirmEmailToken"]) {
			assert.equal(
				requestedProjection.includes(secret), false,
				`${secret} must never be sent to the browser`
			);
		}
	});

	test("carries how many systems the account owns", async () => {
		target = makeUser();
		systemCount = 3;

		const { body } = await update(target._id, { plan: "supporter" });

		assert.equal(body.user.systemCount, 3);
	});
});

// --- deletion ---------------------------------------------------------------

describe("deleting an account", () => {

	test("an account that still owns systems is refused", async () => {
		target = makeUser();
		systemCount = 2;

		const { status, body } = await remove(target._id);

		assert.equal(status, 409);
		// Those systems have API keys in a running trunk-recorder and calls
		// already uploaded; orphaning them silently is worse than refusing.
		assert.match(body.message, /still owns 2 systems/);
		assert.deepEqual(deleted, []);
	});

	test("the refusal counts systems in the singular too", async () => {
		target = makeUser();
		systemCount = 1;

		const { body } = await remove(target._id);

		assert.match(body.message, /still owns 1 system\b/);
	});

	test("an account owning nothing is deleted", async () => {
		target = makeUser();
		systemCount = 0;

		const { status, body } = await remove(target._id);

		assert.equal(status, 200);
		assert.equal(body.success, true);
		assert.equal(deleted.length, 1);
		assert.ok(deleted[0].equals(target._id));
	});
});

// --- accounts that are not there --------------------------------------------

describe("acting on an account that does not exist", () => {

	test("updating one is a 404", async () => {
		target = null;

		const { status, body } = await update(new ObjectId(), { plan: "supporter" });

		assert.equal(status, 404);
		assert.equal(body.success, false);
	});

	test("deleting one is a 404", async () => {
		target = null;

		const { status, body } = await remove(new ObjectId());

		assert.equal(status, 404);
		assert.equal(body.success, false);
	});
});
