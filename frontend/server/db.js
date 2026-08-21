var MongoClient = require('mongodb').MongoClient;


// This file read MONGO_TRUNK_FRONTEND_USER and _PASS and then never used them -
// the URL below was assembled without credentials. Nothing was broken while
// Mongo accepted unauthenticated connections, but index.js calls db.connect() at
// startup and does process.exit(1) if it fails, and the container restarts
// always. So turning on Mongo authentication would have put the frontend into a
// crash loop and taken the whole site down.
//
// MONGO_USER / MONGO_PASSWORD now, the same pair every other service reads,
// with the old names kept as a fallback so an environment that only sets those
// still works. Same shape as backend/config/mongo-url.js; it cannot be shared,
// because this is a separate Docker build context.
var host = process.env['MONGO_HOST']
  || process.env['MONGO_NODE_DRIVER_HOST']
  || 'localhost';
var port = process.env['MONGO_PORT']
  || process.env['MONGO_NODE_DRIVER_PORT']
  || 27017;
var dbUser = process.env['MONGO_USER'] || process.env['MONGO_TRUNK_FRONTEND_USER'];
var dbPass = process.env['MONGO_PASSWORD'] || process.env['MONGO_TRUNK_FRONTEND_PASS'];

var state = {
  db: null,
}

exports.connect = function(done) {
  if (state.db) return done()

  // Truthiness, not != null: compose hands these through as empty strings when
  // the variable is declared but unset, and an empty user builds
  // mongodb://:@host:port, which fails to authenticate and names nobody.
  //
  // Percent-encoded because a password containing @ : / or ? would otherwise
  // end the userinfo section early and the URL would parse into something else.
  var url;
  if (dbUser && dbPass) {
    url = 'mongodb://' + encodeURIComponent(dbUser) + ':' + encodeURIComponent(dbPass)
      + '@' + host + ':' + port + '/scanner';
  } else {
    url = 'mongodb://' + host + ':' + port;
  }

  MongoClient.connect(url, function(err, client) {
    if (err) return done(err)

        //test.equal(true, result);
        state.db = client.db('scanner');
        done();
  })
}

exports.get = function() {
  return state.db
}

exports.close = function(done) {
  if (state.db) {
    state.db.close(function(err, result) {
      state.db = null
      state.mode = null
      done(err)
    })
  }
}