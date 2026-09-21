/**
 * Removes public-read from call audio already in the bucket.
 *
 *   docker exec hamrecorder-backend-1 node /home/app/scripts/make-media-private.js
 *   docker exec hamrecorder-backend-1 node /home/app/scripts/make-media-private.js --dry-run
 *
 * Uploads no longer set an ACL, but everything recorded before that is still
 * world-readable, and the object keys are guessable. Until this has run, the
 * listener gate can be walked around by anyone who knows or guesses a URL.
 *
 * Sets each object back to private. Safe to re-run - setting private on an
 * already-private object is a no-op.
 */
const { ListObjectsV2Command, PutObjectAclCommand } = require("@aws-sdk/client-s3");
// Settings and client both come from config/s3.js, the only place the S3_*
// variables are read. This script kept its own copy, defaulting to upstream
// openmhz's Wasabi bucket - a worse default here than anywhere, since this
// rewrites ACLs across a whole bucket. s3Client() refuses to build against an
// unconfigured environment, so a missing variable stops this before it lists
// a single object.
const { s3Client, bucket: s3_bucket, endpoint: s3_endpoint } = require("../config/s3");

const dryRun = process.argv.includes('--dry-run');

const client = s3Client();

async function main() {
  console.log(`Bucket: ${s3_bucket} at ${s3_endpoint}${dryRun ? '  (dry run)' : ''}`);

  let token = undefined;
  let seen = 0;
  let changed = 0;
  let failed = 0;

  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: s3_bucket,
      Prefix: 'media/',
      ContinuationToken: token,
    }));

    for (const obj of page.Contents || []) {
      seen++;
      if (dryRun) {
        if (seen <= 5) console.log(`  would set private: ${obj.Key}`);
        continue;
      }
      try {
        await client.send(new PutObjectAclCommand({
          Bucket: s3_bucket,
          Key: obj.Key,
          ACL: 'private',
        }));
        changed++;
        if (changed % 100 === 0) console.log(`  ${changed} objects set private...`);
      } catch (err) {
        failed++;
        console.error(`  FAILED ${obj.Key}: ${err.message}`);
      }
    }

    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  console.log(`\nObjects seen: ${seen}`);
  if (dryRun) {
    console.log('Dry run - nothing changed.');
  } else {
    console.log(`Set private:  ${changed}`);
    if (failed) console.log(`Failed:       ${failed}`);
  }
}

main().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
