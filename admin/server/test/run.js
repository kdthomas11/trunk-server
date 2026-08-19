#!/usr/bin/env node
/**
 * Runs the admin server suite and fails if it ran fewer tests than it should.
 *
 *   docker exec -w /app hamrecorder-admin-1 node test/run.js
 *   npm run test:server                              (from admin/)
 *
 * `node --test` exits 0 when its pattern matches no files - it reports
 * "tests 0" and succeeds - so the count is checked against FLOOR below.
 *
 * A near-copy of the same file in account/server/test and backend/test. The
 * three services are separate Docker build contexts, so a shared module would
 * mean publishing one or restructuring the images; until then this is
 * duplicated on purpose.
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

/** Fail if fewer than this many tests ran. Bump when you add tests. */
const FLOOR = 18;

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
		`      If tests were deliberately removed, lower FLOOR in this file.`
	);
	process.exit(1);
}

console.log("OK");
