#!/usr/bin/env node
/**
 * Runs the server suite and fails if it ran fewer tests than it should have.
 *
 *   node server/test/run.js          from account/
 *   node test/run.js                 from inside the container, where /app is server/
 *
 * `node --test` exits 0 when its pattern matches no files at all - it reports
 * "tests 0" and succeeds. So a renamed directory, a moved file, or a typo in the
 * glob turns the whole suite off and CI stays green while testing nothing. That
 * is a worse failure than a red build, because nothing draws attention to it.
 *
 * This runs the suite and then checks the count against FLOOR. Raise FLOOR when
 * you add tests; it is a floor rather than an exact count so adding one does not
 * fail the build, but deleting one does.
 *
 * The glob is resolved from this file's own location rather than the working
 * directory, so it behaves the same from account/, from server/, and from /app.
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

/** Fail if fewer than this many tests ran. Bump when you add tests. */
const FLOOR = 28;

const pattern = path.join(__dirname, "**", "*.test.js");

const result = spawnSync(
	process.execPath,
	["--test", "--test-reporter=tap", pattern],
	{ encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }
);

const output = result.stdout || "";
process.stdout.write(output);

if (result.error) {
	console.error(`\nCould not start the test runner: ${result.error.message}`);
	process.exit(1);
}

/** Reads a trailing TAP summary line, e.g. "# pass 13". */
function count(label) {
	const match = output.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
	return match ? Number(match[1]) : null;
}

const tests = count("tests");
const pass = count("pass");
const fail = count("fail");

if (tests === null || pass === null || fail === null) {
	console.error("\nCould not read a TAP summary from the test output.");
	console.error("Something changed about the reporter - this check cannot vouch for the run.");
	process.exit(1);
}

console.log(`\n${tests} tests, ${pass} passed, ${fail} failed  (floor ${FLOOR})`);

if (fail > 0 || result.status !== 0) {
	console.error(`FAIL  ${fail} failing test${fail === 1 ? "" : "s"}.`);
	process.exit(1);
}

if (tests < FLOOR) {
	console.error(
		`\nFAIL  only ${tests} tests ran, expected at least ${FLOOR}.\n` +
		`      Nothing failed, which means tests went missing rather than broke.\n` +
		`      Check that ${path.relative(process.cwd(), pattern)} still matches them.\n` +
		`      If tests were deliberately removed, lower FLOOR in this file.`
	);
	process.exit(1);
}

console.log("OK");
