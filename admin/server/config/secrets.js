// Assembles configuration from the environment. Nothing secret is stored in
// this file - the credentials it references come from the env, so it is safe to
// commit. Set them in prod.env / test.env, which are gitignored.
const crypto = require("crypto");

const mongo_host = typeof process.env['MONGO_HOST'] !== 'undefined' ? process.env['MONGO_HOST'] : 'mongo';
const mongo_port = typeof process.env['MONGO_PORT'] !== 'undefined' ? process.env['MONGO_PORT'] : 27017;
const mongo_user = process.env['MONGO_USER'];
const mongo_password = process.env['MONGO_PASSWORD'];

let mongoUrl;

// Truthiness, not typeof. Compose passes these through as empty strings when
// the variable is declared but unset in the env file, and `typeof "" !==
// 'undefined'` is true - which built mongodb://:@mongo:27017/scanner and then
// failed to authenticate with an error naming no user.
//
// No authSource: the user lives in `scanner`, so the default - the database in
// the URL - is the right one. Matches backend/config/mongo-url.js.
//
// Percent-encoded: a password containing @ : / or ? would otherwise terminate
// the userinfo section early.
if (mongo_user && mongo_password) {
  console.log("Using authentication for MongoDB - user: " + mongo_user);
  mongoUrl = 'mongodb://' + encodeURIComponent(mongo_user) + ':' + encodeURIComponent(mongo_password)
    + '@' + mongo_host + ':' + mongo_port + '/scanner';
} else {
  mongoUrl = 'mongodb://' + mongo_host + ':' + mongo_port + '/scanner';
}

// SESSION_SECRET signs the session cookie that the account, admin and backend
// services share. It has to be identical across all three and unique to this
// deployment: the value that used to be hardcoded here was the upstream default,
// and is therefore public in every fork of this repo.
const sessionSecret = process.env['SESSION_SECRET'];

if (!sessionSecret) {
	if (process.env['NODE_ENV'] === 'production') {
		throw new Error("SESSION_SECRET is not set. Generate one with: openssl rand -base64 48");
	}
	console.warn("WARNING: SESSION_SECRET is not set. Using a throwaway value for this process - sessions will not survive a restart and will not be shared with the other services.");
}

const secrets = {
	db: mongoUrl,
	sessionSecret: sessionSecret || crypto.randomBytes(48).toString("base64")
}

module.exports = secrets

