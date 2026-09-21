/**
 * The object store configuration gate.
 *
 *   docker exec -w /home/app hamrecorder-backend-1 node test/run.js
 *
 * config/s3.js is the only S3 reader in the service with no fallback values.
 * The other four - controllers/media.js, controllers/uploads.js,
 * transcription/worker.js and scripts/make-media-private.js - each default to
 * `openmhz-west` on `s3.us-west-1.wasabisys.com`, which is upstream openmhz's
 * bucket rather than ours. Deployment is self-hosted MinIO, so that default is
 * never right, and retention.js deletes through this module. A missing variable
 * has to stop the service, not be guessed at.
 *
 * Every test re-requires the module, because it reads the environment once at
 * load and node caches it.
 */
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const MODULE = require.resolve("../config/s3");
const VARS = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_PROFILE"];

let saved;

/** Loads config/s3.js fresh against whatever is in process.env right now. */
function reload() {
	delete require.cache[MODULE];
	return require("../config/s3");
}

function setAll() {
	process.env.S3_ENDPOINT = "http://minio:9000";
	process.env.S3_REGION = "us-east-1";
	process.env.S3_BUCKET = "hamrecorder-prod";
	process.env.S3_PROFILE = "minio";
}

beforeEach(() => {
	saved = {};
	for (const name of VARS) saved[name] = process.env[name];
	setAll();
});

afterEach(() => {
	for (const name of VARS) {
		if (saved[name] === undefined) delete process.env[name];
		else process.env[name] = saved[name];
	}
	delete require.cache[MODULE];
});

describe("refusing to guess at the object store", () => {

	test("a fully configured environment is accepted", () => {
		const s3 = reload();

		assert.doesNotThrow(() => s3.assertConfigured());
		assert.equal(s3.bucket, "hamrecorder-prod");
		assert.equal(s3.endpoint, "http://minio:9000");
	});

	for (const missing of VARS) {
		test(`${missing} unset stops the service`, () => {
			delete process.env[missing];
			const s3 = reload();

			assert.throws(() => s3.assertConfigured(), new RegExp(missing));
		});
	}

	/**
	 * docker-compose passes a variable that is listed but unset in the env file
	 * through as "", which would otherwise sign requests against a bucket
	 * literally named "".
	 */
	test("an empty string counts as unset", () => {
		process.env.S3_BUCKET = "";
		const s3 = reload();

		assert.throws(() => s3.assertConfigured(), /S3_BUCKET/);
	});

	test("the error names every missing variable, not just the first", () => {
		delete process.env.S3_BUCKET;
		delete process.env.S3_PROFILE;
		const s3 = reload();

		assert.throws(() => s3.assertConfigured(), (err) => {
			assert.match(err.message, /S3_BUCKET/);
			assert.match(err.message, /S3_PROFILE/);
			return true;
		});
	});

	/**
	 * The one variable that keeps a default, because false is a real answer:
	 * path-style addressing is what MinIO needs and ordinary S3 does not.
	 */
	test("forcePathStyle defaults to false rather than being required", () => {
		delete process.env.S3_FORCE_PATH_STYLE;
		const s3 = reload();

		assert.doesNotThrow(() => s3.assertConfigured());
		assert.equal(s3.forcePathStyle, false);
	});

	test("forcePathStyle is on only for the exact string 'true'", () => {
		process.env.S3_FORCE_PATH_STYLE = "true";
		assert.equal(reload().forcePathStyle, true);

		process.env.S3_FORCE_PATH_STYLE = "yes";
		assert.equal(reload().forcePathStyle, false);

		delete process.env.S3_FORCE_PATH_STYLE;
	});

	/**
	 * No Wasabi anywhere. This module used to carry the same upstream defaults
	 * as the other four readers; the point of the change was removing them.
	 */
	test("nothing falls back to upstream's bucket", () => {
		for (const name of VARS) delete process.env[name];
		const s3 = reload();

		assert.equal(s3.bucket, undefined);
		assert.equal(s3.endpoint, undefined);
		assert.equal(s3.profile, undefined);
		assert.throws(() => s3.s3Client(), /S3_/);
	});
});
