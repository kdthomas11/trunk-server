/**
 * The Mongo connection string, assembled from the environment.
 *
 * index.js and config/session.js built this independently from the same four
 * variables, with identical logic in both - so adding a replica set, TLS, or an
 * auth source meant finding and changing both, and the session store failing to
 * connect while the app succeeded is a confusing way to discover you missed one.
 *
 * Assembled once at require time and exported as a string: node caches the
 * module, so the "using authentication" line below is logged once rather than
 * per caller.
 *
 * Now the ONLY way a Mongo URL is built in this service. controllers/uploads.js
 * and transcribe-worker.js used to assemble their own from
 * MONGO_NODE_DRIVER_HOST / MONGO_NODE_DRIVER_PORT, honouring neither
 * MONGO_USER nor MONGO_PASSWORD - the transcriber was handed both credentials
 * in docker-compose.yml and ignored them. Everything resolved to the same
 * 'mongo' host, so nothing was broken while authentication was off. Turn
 * authentication on and the API would have connected while audio ingest and
 * transcription silently stopped: the two paths with nobody watching them.
 *
 * Which variable wins: MONGO_HOST / MONGO_PORT, falling back to the
 * MONGO_NODE_DRIVER_* pair so a deployment that only sets those keeps working.
 * Both are read here so there is one place to look.
 */
const mongo_host = process.env['MONGO_HOST']
  || process.env['MONGO_NODE_DRIVER_HOST']
  || 'mongo';
const mongo_port = process.env['MONGO_PORT']
  || process.env['MONGO_NODE_DRIVER_PORT']
  || 27017;
const mongo_user = process.env['MONGO_USER'];
const mongo_password = process.env['MONGO_PASSWORD'];

let mongoUrl;

// Truthiness, not typeof. These arrive from docker-compose as empty strings
// when the variable is declared but unset in the env file, and `typeof "" !==
// 'undefined'` is true - which built mongodb://:@mongo:27017/scanner and failed
// to connect with an authentication error that named no user.
if (mongo_user && mongo_password) {
  console.log("Using authentication for MongoDB - user: " + mongo_user);
  // Percent-encoded: a password containing @ / : or ? otherwise terminates the
  // userinfo section early and the URL parses into something else entirely.
  // No authSource: the user is created in `scanner`, so the default - the
  // database named in the URL - is right. Deliberate, because account, admin
  // and the frontend server each build their own URL and none of them can set
  // an authSource. Putting the user in `admin` would have worked here and
  // broken all three.
  mongoUrl = 'mongodb://' + encodeURIComponent(mongo_user) + ':' + encodeURIComponent(mongo_password)
    + '@' + mongo_host + ':' + mongo_port + '/scanner';
} else {
  mongoUrl = 'mongodb://' + mongo_host + ':' + mongo_port + '/scanner';
}

module.exports = mongoUrl;
