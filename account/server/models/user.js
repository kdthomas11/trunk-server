// Defining a User Model in mongoose
// Code modified from https://github.com/sahat/hackathon-starter
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");




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
	// Mirrors callsign - see the pre-save hook below. Kept as its own field so
	// showScreenName on systems and the existing admin queries keep working.
	screenName: {
		type: String,
		unique: true,
		lowercase: true
	},
	// Stored lowercase so the unique index enforces case-insensitively - N6KEN
	// and n6ken cannot become two accounts. Uppercased for display only.
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
	// Optional: much of the world has no state or province.
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
	// Set from the admin portal. A disabled account keeps its data and its
	// systems - it just cannot sign in and cannot listen. Deleting is the
	// destructive option; this is the reversible one.
	disabled: {
		type: Boolean,
		default: false
	},
	disabledAt: Date,
	disabledReason: String,
	// What this account has paid for, or been given. "Supporter" is the only
	// word a user ever sees for it - never premium, paid or pro - because it
	// covers both people who subscribe and people who donate.
	//
	// A string enum rather than a boolean so further tiers need no migration.
	// Deliberately NOT called planType: that name already means something else
	// on the System model (its archive tier), and one name for two entities is
	// how a billing bug happens.
	plan: {
		type: String,
		enum: ['free', 'supporter'],
		default: 'free'
	},
	// Granted by an admin for now; Stripe comes later. Recording who and when is
	// cheap today and impossible to reconstruct afterwards - and once Supporter
	// can be earned by either a subscription or a one-off donation, "why does
	// this account have it" becomes a real support question.
	planGrantedAt: Date,
	planGrantedBy: mongoose.Schema.Types.ObjectId,
	terms: {
		type: Number,
		default: 0
	},
	ver: {
		type: Number,
		default: 1.1
	},
	sysCount: Number,
	lastLogin: { type : Date, default: Date.now }
})

/**
 * Password hash middleware.
 */
/*
UserSchema.pre("save", function(next) {
	var user = this
	if (!user.isModified("password")) return next()
	bcrypt.genSalt(8, (err, salt) => {
		if (err) return next(err)
		bcrypt.hash(user.password, salt, null, (err, hash) => {
			if (err) return next(err)
			user.password = hash
			user.local.password = hash;
			next()
		})
	})
})*/

/**
 * The callsign is the account's public identity, so screenName is derived from
 * it rather than entered separately. Both carry lowercase: true, so this stays
 * normalized whatever case the callsign arrives in.
 */
UserSchema.pre("save", function(next) {
	if (this.isModified("callsign") && this.callsign) {
		this.screenName = this.callsign;
	}
	next();
});

/**
 * Work factor for new hashes.
 *
 * Was 8, which is below current guidance - OWASP puts the floor at 10 and 12 in
 * practice - and materially cheapens an offline attack if the database is ever
 * taken. Raising it was only safe once the hashing moved off the *Sync calls:
 * bcrypt at cost 12 takes roughly 300ms, and hashSync/compareSync block the
 * whole event loop for that long, not just the one request. Bumping the cost
 * without this change would have been a self-inflicted denial of service.
 *
 * Existing hashes are upgraded on next successful sign-in - see needsRehash
 * below and its caller in config/passport-strategies/local.js. Nobody has to
 * reset a password.
 */
const BCRYPT_COST = 12;

/**
 * Password hash middleware.
 */
UserSchema.pre("save", function(next) {
    if(!this.isModified("password")) {
        return next();
    }
    // `hashed` used to be an undeclared assignment, so it was a global. Harmless
    // only because hashSync blocked; with the async call below, two concurrent
    // saves would have raced on it.
    bcrypt.hash(this.password, BCRYPT_COST, (err, hashed) => {
        if (err) return next(err);
        this.password = hashed;
        // Some legacy documents have no `local` subdocument at all, and
        // comparePassword reads from it - so a user saved without this would
        // have a hash nothing could check against.
        if (!this.local) this.local = {};
        this.local.password = hashed;
        next();
    });
});

/**
 * True when this account's hash predates BCRYPT_COST and should be upgraded.
 *
 * getRounds throws on anything that is not a bcrypt hash, which includes the
 * empty string and undefined. An account we cannot read the cost of is left
 * alone rather than rehashed on a guess.
 */
UserSchema.methods.needsRehash = function() {
	try {
		return bcrypt.getRounds(this.local.password) < BCRYPT_COST;
	} catch (err) {
		return false;
	}
};

/*
 Defining our own custom document instance method
 */
/*
 UserSchema.methods = {
 	comparePassword: function(candidatePassword, cb) {
 		bcrypt.compare(candidatePassword, this.local.password, (err, isMatch) => {
 			if (err) return cb(err)
 			cb(null, isMatch)
 		})
 	}
 }*/

 UserSchema.methods.comparePassword = function(plaintext, callback) {
    // bcrypt.compare, not compareSync: the sync form blocks the event loop for
    // the whole hash, so every concurrent request waits on one sign-in. At cost
    // 12 that is around 300ms per login.
    //
    // The guard matters as much as the async move. bcrypt throws "Illegal
    // arguments" when the stored hash is undefined or empty, which turned an
    // account with no password set into a 500 instead of a refused login.
    if (!this.local || typeof this.local.password !== "string" || this.local.password.length === 0) {
        return callback(null, false);
    }
    return bcrypt.compare(plaintext, this.local.password, callback);
};


/**
* Statics
*/
UserSchema.statics = {}

module.exports = mongoose.model("User", UserSchema)
