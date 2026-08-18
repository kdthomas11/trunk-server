// Defining a User Model in mongoose
// Code modified from https://github.com/sahat/hackathon-starter
var mongoose = require("mongoose");
var crypto = require("crypto");



const UserSchema = new mongoose.Schema({
	local: {
		name: String,
		email: String,
		password: String
	},
	email: {
		type: String,
		unique: true,
		lowercase: true
	},
	password: String,
	screenName: {
		type: String,
		unique: true,
		lowercase: true
	},
	// Kept in step with account/server/models/user.js. The backend only reads
	// these - accounts are created and edited by the account service - but a
	// field missing from this schema is silently dropped from query results.
	callsign: {
		type: String,
		unique: true,
		lowercase: true,
		trim: true,
		maxlength: 7
	},
	firstName: String,
	lastName: String,
	city: String,
	state: String,
	country: String,
	resetPasswordToken: String,
	resetPasswordTTL: Date,
	confirmEmail: {
		type: Boolean,
		default: false
	},
	confirmEmailToken: String,
	confirmEmailTTL: Date,
	admin: {
		type: Boolean,
		default: false
	},
	disabled: {
		type: Boolean,
		default: false
	},
	disabledAt: Date,
	disabledReason: String,
	// Read-only here - the account service owns writes. Must exist in this
	// schema all the same: a field missing from it is silently dropped from
	// query results, so req.listener.plan would be undefined and every account
	// would read as free with nothing erroring anywhere.
	plan: {
		type: String,
		enum: ['free', 'supporter'],
		default: 'free'
	},
	planGrantedAt: Date,
	planGrantedBy: mongoose.Schema.Types.ObjectId,
	terms: {
		type: Number,
		default: 0
	},
	// 1.1, matching account and admin. This read 1.2 here since the first
	// commit, so a user document with no `ver` of its own hydrated as 1.2 in
	// backend and 1.1 in the other two - the same record answering differently
	// depending on which service was asked.
	//
	// 1.1 is the value that is actually true: account owns every write, and
	// every stored user has ver 1.1. Nothing reads this field in any service,
	// which is the only reason the disagreement never surfaced as a bug.
	ver: {
		type: Number,
		default: 1.1
	},
	sysCount: Number,
	lastLogin: { type : Date, default: Date.now }
})

// No password hashing and no comparePassword here on purpose - the same reason
// admin/server/models/user.js has none. The account service owns every write to
// a user, and it is the only place that should hash a password. Backend reads
// users; it never creates or authenticates one, and the listener gate in
// middleware/auth.js works from the shared session, not from a password.
//
// What used to be here was a pre-save hook and a comparePassword, both calling
// bcrypt-nodejs. Nothing in backend ever reached either: no code path here saves
// a user, and the only caller of comparePassword anywhere is admin's local
// strategy, which uses admin's own model. The hook also called
// bcrypt.hash(data, salt, null, cb) - bcrypt-nodejs' four-argument form, which
// the maintained bcrypt package does not accept - so it was dead code that
// pinned an unmaintained dependency and would have thrown if it ever ran.

/**
* Statics
*/
UserSchema.statics = {}

module.exports=mongoose.model("User", UserSchema)
