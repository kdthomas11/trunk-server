/**
 * The object store settings, and the clients built from them.
 *
 * Now the ONLY place this service reads S3_ENDPOINT / S3_REGION / S3_BUCKET /
 * S3_PROFILE / S3_PUBLIC_URL / S3_FORCE_PATH_STYLE. The same block used to be
 * copied into controllers/media.js, controllers/uploads.js,
 * transcription/worker.js and scripts/make-media-private.js - four independent
 * chances for the bucket a call is deleted from to drift from the one it was
 * written to. Same reasoning as config/mongo-url.js, which collected the Mongo
 * URL after the transcriber spent a while connecting somewhere else.
 *
 * There are NO fallback values, which is the second half of the change. Those
 * four copies each defaulted to `openmhz-west` on `s3.us-west-1.wasabisys.com`
 * with the `wasabi-account` profile - upstream openmhz's bucket, never ours,
 * and deployment is self-hosted MinIO so it never will be. For code that reads,
 * a wrong default fails a download; for retention.js, which deletes, guessing
 * at a bucket is the last thing anyone wants. A missing variable is an error.
 *
 * They also used `??`, which falls back on undefined but not on "" - and
 * docker-compose hands over a declared-but-unset variable as the empty string.
 * assertConfigured() treats blank as missing for that reason.
 *
 * `forcePathStyle` keeps a default because false is meaningful: it is the
 * ordinary S3 addressing mode and only MinIO needs it turned on. It is still
 * the one that bites - docker-test.sh drops local-compose.yml, which is where
 * S3_FORCE_PATH_STYLE is set, so a test run talks to MinIO in virtual-host
 * style and the uploads look like data loss.
 */
const { S3Client } = require("@aws-sdk/client-s3");
const { fromIni } = require("@aws-sdk/credential-providers");

const endpoint = process.env['S3_ENDPOINT'];
const region = process.env['S3_REGION'];
const bucket = process.env['S3_BUCKET'];
const profile = process.env['S3_PROFILE'];
const forcePathStyle = (process.env['S3_FORCE_PATH_STYLE'] ?? 'false') === 'true';

/**
 * Where the browser fetches audio from, baked into each call's stored `url`.
 *
 * Unlike `endpoint`, which is internal DNS, this one has to resolve from
 * outside the host. Derived from endpoint and bucket when unset, which is what
 * uploads.js did; left undefined rather than built out of "undefined" when
 * neither is configured, so a broken environment does not produce a plausible
 * looking URL.
 */
const publicUrl = process.env['S3_PUBLIC_URL']
  || (endpoint && bucket ? `${endpoint}/${bucket}` : undefined);

/**
 * How many times a request is tried. Two, everywhere.
 *
 * uploads.js and transcription/worker.js both chose 2 deliberately; media.js
 * set nothing and so got the SDK default of 3. One number now, because "how
 * many times does this retry" should not depend on which file is asking.
 */
const MAX_ATTEMPTS = 2;

const REQUIRED = { S3_ENDPOINT: endpoint, S3_REGION: region, S3_BUCKET: bucket, S3_PROFILE: profile };

/**
 * Throws unless the object store is fully configured.
 *
 * Called from index.js at startup, so a broken environment file stops the
 * service on boot with a message naming the variable - rather than at 3am, in
 * the retention sweep, pointed at whatever the default happened to be.
 *
 * Deliberately NOT run at require time. The backend suite runs with no S3
 * environment at all (see the comment on the backend job in
 * .github/workflows/tests.yaml) and requires this module through retention.js;
 * throwing on require would turn an unconfigured environment into a suite that
 * cannot load. Nothing under test builds a client, so gating the client is
 * enough to keep every path that really talks to the store covered.
 *
 * Empty strings count as missing: docker-compose passes a declared-but-unset
 * variable through as "", which would otherwise sign requests against a bucket
 * named "".
 */
function assertConfigured() {
  const missing = Object.keys(REQUIRED).filter(name => !REQUIRED[name]);
  if (missing.length === 0) return;
  throw new Error(
    `Object store is not configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} unset. ` +
    `Set ${missing.length === 1 ? "it" : "them"} in the env file for this stage - there is no default. ` +
    `Uploads, playback, transcription and the retention sweep all read these, and retention deletes.`
  );
}

/**
 * A new client against the configured store.
 *
 * `overrides` is spread last, for the one caller that needs something of its
 * own: controllers/uploads.js runs every recording through a keep-alive agent
 * with 250 sockets, and ingest is the hot path, so it keeps that handler rather
 * than sharing the default one.
 */
function createS3Client(overrides = {}) {
  assertConfigured();
  return new S3Client({
    credentials: fromIni({ profile: profile }),
    endpoint: endpoint,
    region: region,
    maxAttempts: MAX_ATTEMPTS,
    forcePathStyle: forcePathStyle,
    ...overrides,
  });
}

/**
 * The shared client, built lazily rather than at require time.
 *
 * fromIni() reads ~/.aws/credentials, and test/calls.test.js requires the
 * controllers - and through them this module - with no such file present. At
 * require time that turns a missing credentials file into a failure to load the
 * suite; deferred, it only matters to code that actually sends a request.
 *
 * assertConfigured() runs through createS3Client() on the way, which is the
 * backstop for anything reaching the store without going through index.js -
 * the one-off scripts, and transcription/worker.js in its own process.
 */
let client;

function s3Client() {
  if (!client) client = createS3Client();
  return client;
}

module.exports = {
  s3Client, createS3Client, assertConfigured,
  endpoint, region, bucket, profile, publicUrl, forcePathStyle,
};
