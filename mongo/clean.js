/**
 * Retired. Does nothing on purpose.
 *
 * This deleted every call older than a month straight out of the collection.
 * Two things are now wrong with that, and both are silent:
 *
 *   1. It cannot delete audio. A mongo shell has no object store credentials,
 *      so every call it removed left its .m4a in the bucket with nothing naming
 *      the key - unreachable, invisible, and paid for forever. Clearing that
 *      backlog is what backend/scripts/delete-orphaned-audio.js is for.
 *
 *   2. It cannot see stars. A starred call is meant to outlive retention until
 *      the last listener unstars it, and this would take it anyway.
 *
 * Retention now lives in backend/retention.js, runs nightly at 3am from
 * backend/index.js, and does both. To run it by hand:
 *
 *   docker exec hamrecorder-backend-1 node -e \
 *     "require('/home/app/retention').cleanOldCalls({ dryRun: true })"
 *
 * Drop dryRun to actually delete. This file is kept, rather than removed, so
 * that a runbook or cron entry still pointing here fails loudly instead of
 * quietly orphaning another month of audio.
 */
print("");
print("clean.js is retired and has deleted nothing.");
print("");
print("It removed call documents but never their audio, which is where the");
print("orphaned .m4a files in the bucket came from, and it ignored starred");
print("calls. Retention is now backend/retention.js, run nightly at 3am.");
print("");
print("By hand:");
print("  docker exec hamrecorder-backend-1 node -e \\");
print("    \"require('/home/app/retention').cleanOldCalls({ dryRun: true })\"");
print("");
print("Orphans left behind by this script:");
print("  docker exec hamrecorder-backend-1 node /home/app/scripts/delete-orphaned-audio.js --dry-run");
print("");
