var mongoose = require('mongoose');
var User = require('./user');

const systemSchema = mongoose.Schema({
    name: String,
    shortName: String,
    systemType: String,
    county: String,
    country: String,
    city: String,
    state: String,
    description: String,
    status: String,
    showScreenName: Boolean,
    allowContact: {
          type: Boolean,
          default: true
      },
    callAvg: Number,
    callCount: Number,
    ignoreUnknownTalkgroup : Boolean,
    active: {type: Boolean, default: false},
    lastActive: Date,
    userId:  {type: mongoose.Schema.Types.ObjectId, ref: 'User'},
    key: String
  });

  // generateHash and validPassword used to sit here, hashing a system's upload
  // credential with bcrypt-nodejs. Neither was ever called: uploads authenticate
  // in controllers/uploads.js by comparing the submitted api_key against the
  // plaintext `key` field above. validPassword could not have worked anyway - it
  // read this.local.password, and there is no `local` on this schema.
  //
  // That the API key is stored in plaintext is a real question, but a separate
  // one from removing code that never ran.

  module.exports = systemSchema;