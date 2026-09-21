/**
 * Entrypoint for the transcriber service.
 *
 * Runs the same image as the backend with a different command, so there is no
 * second Dockerfile and no second lockfile to keep in step.
 */
const mongoose = require('mongoose');
const callSchema = require('./models/callSchema');
const worker = require('./transcription/worker');

// Built in config/mongo-url.js, not here. This file assembled its own from
// MONGO_NODE_DRIVER_* and ignored MONGO_USER / MONGO_PASSWORD, which
// docker-compose has been handing this service all along. Enabling Mongo
// authentication would have stopped transcription silently.
const mongoUrl = require('./config/mongo-url');

/** The URL with any password taken out, so it is safe to log. */
function redactedUrl(url) {
  return url.replace(/\/\/[^@/]*@/, '//<credentials>@');
}

async function main() {
  // This process fetches audio from the object store, and none of the S3
  // settings has a default any more - they used to fall back to upstream
  // openmhz's Wasabi bucket. The backend checks these at its own startup, but
  // this is a separate process with a separate command, so it checks too.
  // Before Mongo, so a broken env file fails on the first line rather than
  // after a connection that looked like progress.
  require('./config/s3').assertConfigured();

  await mongoose.connect(mongoUrl);
  console.log(new Date().toISOString(), '[transcriber]', `connected to ${redactedUrl(mongoUrl)}`);

  const Call = mongoose.model('Call', callSchema);

  // Build the partial index before claiming anything. Without it the claim
  // query is a full collection scan every poll, forever - invisible except as
  // unexplained mongo CPU.
  await Call.syncIndexes();
  console.log(new Date().toISOString(), '[transcriber]', 'indexes ready');

  await worker.run(Call);
  await mongoose.disconnect();
}

// Compose sends SIGTERM on stop. Finish the call in flight rather than leaving
// a claim behind for the TTL to clean up ten minutes later.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(new Date().toISOString(), '[transcriber]', `${signal} - finishing current call`);
    worker.stop();
  });
}

main().catch((err) => {
  console.error(new Date().toISOString(), '[transcriber]', 'fatal:', err);
  process.exit(1);
});
