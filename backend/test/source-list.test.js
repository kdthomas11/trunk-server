/**
 * The source list an uploader sends with each call.
 *
 *   docker exec -w /home/app hamrecorder-backend-1 node test/run.js
 *
 * On D-Star and YSF the tag is a callsign decoded off the air, so it is the one
 * field a stranger with a radio controls. These pin down that it is kept, and
 * that it is kept to a sane size and type.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { clean_src_list, MAX_SOURCE_TAG } = require("../controllers/source-list");

describe("clean_src_list", () => {
	test("keeps a D-Star callsign as the tag", () => {
		assert.deepEqual(
			clean_src_list([{ pos: 0, src: -1, tag: "N6KEN/ID-52" }]),
			[{ pos: 0, src: "-1", tag: "N6KEN/ID-52" }]
		);
	});

	test("leaves tag off when there is none, as on an FM repeater", () => {
		assert.deepEqual(
			clean_src_list([{ pos: 0, src: -1, tag: "" }, { pos: 1.5, src: 1234 }]),
			[{ pos: 0, src: "-1" }, { pos: 1.5, src: "1234" }]
		);
	});

	test("trims and caps a tag, and ignores one that is not a string", () => {
		const [long, notString] = clean_src_list([
			{ pos: 0, src: 1, tag: "  " + "X".repeat(100) + "  " },
			{ pos: 0, src: 2, tag: { $gt: "" } }
		]);
		assert.equal(long.tag.length, MAX_SOURCE_TAG);
		assert.equal(notString.tag, undefined);
	});

	test("drops fields it does not use", () => {
		assert.deepEqual(clean_src_list([{ pos: 2, src: 7, extra: "x" }]), [{ pos: 2, src: "7" }]);
	});

	test("returns an empty list for anything that is not an array", () => {
		assert.deepEqual(clean_src_list(null), []);
		assert.deepEqual(clean_src_list({ pos: 0 }), []);
	});
});
