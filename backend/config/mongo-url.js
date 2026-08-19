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
 * NOT the only way a Mongo URL is built in this service, and deliberately not
 * yet unified with the others, because they are not the same decision:
 *
 *   controllers/uploads.js  and  transcribe-worker.js  read
 *   MONGO_NODE_DRIVER_HOST / MONGO_NODE_DRIVER_PORT rather than MONGO_HOST /
 *   MONGO_PORT, and neither honours MONGO_USER / MONGO_PASSWORD at all. The
 *   transcriber is handed both credentials in docker-compose.yml and ignores
 *   them. Every one of these resolves to the same 'mongo' host today, so
 *   nothing is broken - but turn on Mongo authentication and the API would
 *   connect while uploads and transcription would not.
 *
 * Pointing those two at this module is a configuration change rather than a
 * refactor, so it wants a deliberate decision about which variable wins.
 */
const mongo_host = typeof process.env['MONGO_HOST'] !== 'undefined' ? process.env['MONGO_HOST'] : 'mongo';
const mongo_port = typeof process.env['MONGO_PORT'] !== 'undefined' ? process.env['MONGO_PORT'] : 27017;
const mongo_user = process.env['MONGO_USER'];
const mongo_password = process.env['MONGO_PASSWORD'];

let mongoUrl;

if ((typeof mongo_user !== 'undefined') && (typeof mongo_password !== 'undefined')) {
  console.log("Using authentication for MongoDB - user: " + mongo_user);
  mongoUrl = 'mongodb://' + mongo_user + ':' + mongo_password + '@' + mongo_host + ':' + mongo_port + '/scanner';
} else {
  mongoUrl = 'mongodb://' + mongo_host + ':' + mongo_port + '/scanner';
}

module.exports = mongoUrl;
