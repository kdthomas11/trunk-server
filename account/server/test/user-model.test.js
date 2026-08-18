/**
 * Schema constraints on the User model.
 *
 * These exist because `email` was declared twice in the schema literal - once
 * with { unique: true, lowercase: true } and again, about twenty-five lines
 * further down, as a bare `email: String`. JavaScript keeps the last key, so
 * mongoose never saw the constraints: no unique index was declared and no
 * lowercasing happened. Nothing errored, and the collection kept its unique
 * index only because an earlier version of this schema had created one.
 *
 * A duplicate key in an object literal is invisible on reading. Asserting the
 * resulting options is the only way to notice it, so these tests assert them.
 *
 *   docker exec -w /app hamrecorder-account-1 sh -c "node --test test/*.test.js"
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const User = require("../models/user");

describe("User schema - email", () => {

	test("email is unique and lowercased", () => {
		const options = User.schema.path("email").options;
		// An empty options object is the signature of the duplicate-key bug:
		// the second declaration silently replaced the first.
		assert.equal(options.unique, true, "email must carry a unique constraint");
		assert.equal(options.lowercase, true, "email must be stored lowercase");
	});

	test("a unique index on email is actually declared", () => {
		const indexed = User.schema.indexes().some(
			([keys, opts]) => keys.email === 1 && opts.unique === true
		);
		// Without this, a database built fresh from the schema - a new
		// environment, or a restore into an empty collection - gets no unique
		// index on email at all, and duplicate accounts become possible.
		assert.ok(indexed, "schema must declare a unique index on email");
	});

	test("mixed-case input is normalised on the way in", () => {
		const user = new User({ email: "Mixed.Case@Example.COM" });
		// The unique index is case-sensitive, so without this normalisation
		// Ken@example.com and ken@example.com are two separate accounts.
		assert.equal(user.email, "mixed.case@example.com");
	});
});

describe("User schema - the identity fields", () => {

	// callsign and screenName were never affected by the duplicate key, but they
	// carry the same kind of constraint and the same failure mode if one is ever
	// redeclared, so they are pinned here too.
	for (const field of ["callsign", "screenName"]) {
		test(`${field} is unique and lowercased`, () => {
			const options = User.schema.path(field).options;
			assert.equal(options.unique, true);
			assert.equal(options.lowercase, true);
		});
	}
});
