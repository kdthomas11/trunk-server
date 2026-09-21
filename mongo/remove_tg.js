/**
 * Retired. Does nothing on purpose.
 *
 * This deleted every call on one talkgroup and hid the matching files in
 * Backblaze B2. Four things were wrong with it, and none of them announced
 * itself:
 *
 *   1. B2 is not the object store here - self-hosted MinIO is - and
 *      `backblaze-b2` is not a dependency of any service, so this died at
 *      `require` before reaching a single line of its own logic.
 *   2. Its credentials were empty strings and its bucket was `openmhz-s3`,
 *      upstream openmhz's, not ours.
 *   3. The system and talkgroup were hardcoded to `hennearmer` / 3423 -
 *      upstream's again - so running it meant editing it first.
 *   4. It deleted call documents while leaving their audio, which is exactly
 *      the orphan problem backend/retention.js was written to stop.
 *
 * Replaced by backend/scripts/remove-talkgroup.js, which takes the system and
 * talkgroup as arguments, deletes the audio from MinIO before the documents,
 * and skips calls a listener has starred unless told otherwise:
 *
 *   docker exec hamrecorder-backend-1 node /home/app/scripts/remove-talkgroup.js \
 *     --system <shortName> --talkgroup <num> --dry-run
 *
 * Kept rather than removed so a runbook still pointing here fails loudly.
 */
print("");
print("remove_tg.js is retired and has deleted nothing.");
print("");
print("It hid files in Backblaze B2 - not the object store this uses - and");
print("deleted call documents without their audio. Use:");
print("");
print("  docker exec hamrecorder-backend-1 node /home/app/scripts/remove-talkgroup.js \\");
print("    --system <shortName> --talkgroup <num> --dry-run");
print("");
print("It skips starred calls unless you pass --include-starred.");
print("");
