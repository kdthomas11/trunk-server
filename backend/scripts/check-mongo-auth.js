#!/usr/bin/env node
/**
 * Preflight for turning on Mongo authentication.
 *
 *   docker compose exec backend node scripts/check-mongo-auth.js
 *
 * The mongo service runs with `--auth`. That flag is in docker-compose.yml, so
 * it arrives on any host that pulls this branch - and if the application user
 * has not been created there first, every service loses its database at once.
 * The frontend is the worst of them: server/index.js calls process.exit(1) when
 * its first connection fails, in a container that restarts always, so the whole
 * site goes down rather than degrading.
 *
 * Run this BEFORE restarting the stack on a host that is about to get `--auth`
 * for the first time. It answers one question: would the services be able to
 * connect after the restart?
 *
 * Exit codes:
 *   0  credentials work - safe to restart
 *   1  something is wrong, and the message says which thing
 *
 * Deliberately reads the environment the same way the services do, rather than
 * taking arguments, so that "the check passed" means "the thing the services
 * will actually do, works".
 */
const { MongoClient } = require("mongodb");

const host = process.env["MONGO_HOST"] || process.env["MONGO_NODE_DRIVER_HOST"] || "mongo";
const port = process.env["MONGO_PORT"] || process.env["MONGO_NODE_DRIVER_PORT"] || 27017;
const user = process.env["MONGO_USER"];
const password = process.env["MONGO_PASSWORD"];

const TIMEOUT_MS = 5000;

function fail(message, detail) {
  console.error("\nFAIL  " + message);
  if (detail) console.error("      " + detail);
  process.exit(1);
}

/** Connects and runs a trivial command. Returns null on success, or the error. */
async function tryConnect(url) {
  const client = new MongoClient(url, {
    serverSelectionTimeoutMS: TIMEOUT_MS,
    connectTimeoutMS: TIMEOUT_MS
  });
  try {
    await client.connect();
    await client.db("scanner").command({ ping: 1 });
    // A ping succeeds against an unauthenticated connection even when auth is
    // on, so read something real to know the credentials actually carry rights.
    const count = await client.db("scanner").collection("calls").countDocuments({}, { limit: 1 });
    return { ok: true, count };
  } catch (err) {
    return { ok: false, err };
  } finally {
    await client.close().catch(() => {});
  }
}

(async () => {
  console.log(`Mongo host:  ${host}:${port}`);
  console.log(`MONGO_USER:  ${user ? user : "(not set)"}`);
  console.log(`MONGO_PASSWORD: ${password ? "(set, " + password.length + " chars)" : "(not set)"}`);

  if (!user || !password) {
    fail(
      "MONGO_USER and MONGO_PASSWORD are not both set in this environment.",
      "Every service builds its connection string from these. With --auth on the mongo\n" +
      "      container and these unset, nothing can connect. Set them in prod.env and re-run."
    );
  }

  const authed = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/scanner`;
  const anon = `mongodb://${host}:${port}/scanner`;

  const withCreds = await tryConnect(authed);
  if (!withCreds.ok) {
    const name = withCreds.err && (withCreds.err.codeName || withCreds.err.name);
    if (name === "AuthenticationFailed") {
      fail(
        "The credentials were rejected.",
        "The user may not exist yet, the password may not match, or the user may have been\n" +
        "      created in the wrong database. It must live in `scanner`, not `admin` - none of\n" +
        "      the four services that build a Mongo URL can set an authSource, so the default\n" +
        "      (the database named in the URL) has to be the right one.\n" +
        "      See \"Mongo authentication\" in README.md."
      );
    }
    fail("Could not connect with credentials.", String(withCreds.err && withCreds.err.message));
  }

  console.log(`\nOK    Connected with credentials and read the calls collection.`);

  // Not a failure either way - it tells you which side of the switch you are on.
  const withoutCreds = await tryConnect(anon);
  if (withoutCreds.ok) {
    console.log("NOTE  Anonymous connections still work, so --auth is not active on this host yet.");
    console.log("      That is expected before the restart. The credentials are ready, so the");
    console.log("      restart is safe: run it, then re-run this and anonymous should be refused.");
  } else {
    console.log("OK    Anonymous connections are refused - --auth is active and enforcing.");
  }

  console.log("\nSafe to restart the stack.");
  process.exit(0);
})().catch((err) => {
  fail("Unexpected error running the check.", String(err && err.stack || err));
});
