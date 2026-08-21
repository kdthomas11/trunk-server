const passport = require("passport");
const User = require("../models/user");
const loginEvents = require("./login-events");
const Mailjet = require('node-mailjet');

const crypto = require("crypto");

var admin_email = process.env['REACT_APP_ADMIN_EMAIL'] != null ? process.env['REACT_APP_ADMIN_EMAIL'] : "admin@hamrecorder.com";
var site_name = process.env['REACT_APP_SITE_NAME'] != null ? process.env['REACT_APP_SITE_NAME'] : "HamRecorder";
var account_server = process.env['REACT_APP_ACCOUNT_SERVER'] != null ? process.env['REACT_APP_ACCOUNT_SERVER'] : "https://account.hamrecorder.com";
var cookie_domain = process.env['REACT_APP_COOKIE_DOMAIN'] != null ? process.env['REACT_APP_COOKIE_DOMAIN'] : '.hamrecorder.com'; //'https://s3.amazonaws.com/robotastic';


const mailjet = new Mailjet({
  apiKey: process.env['MAILJET_KEY'],
  apiSecret: process.env['MAILJET_SECRET']
});

	// https://stackoverflow.com/questions/3446170/escape-string-for-use-in-javascript-regex/6969486#6969486
	const escapeRegExp = (string) => {
		return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
	}

/**
 * Constant-time comparison of a confirm or reset token.
 *
 * The empty-string guard is the important part, not the timing. After a
 * successful reset the stored token is set to "" rather than removed, so a
 * stored value of "" means "there is no live token" - and it must never match,
 * whatever arrives. `!=` happened to reject it because Express will not match an
 * empty path segment for a required :token param, but that is the router's
 * accident to keep, not this function's.
 *
 * Both tokens are 40 hex characters (crypto.randomBytes(20)), so comparing
 * lengths first gives nothing away.
 */
const tokensMatch = (submitted, stored) => {
	if (typeof submitted !== "string" || typeof stored !== "string") return false;
	if (submitted.length === 0 || stored.length === 0) return false;
	if (submitted.length !== stored.length) return false;
	return crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(stored));
}

exports.isLoggedIn = function (req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect("/login");
};

// -------------------------------------------


exports.authenticated = function (req, res, next) {
  res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  if (req.isAuthenticated()) {
    var clientUser = (({
      firstName,
      lastName,
      screenName,
      callsign,
      city,
      state,
      country,
      email,
      admin,
      plan,
      terms
    }) => ({
      firstName,
      lastName,
      screenName,
      callsign,
      city,
      state,
      country,
      email,
      admin,
      plan,
      terms
    }))(
      req.user
    );
    clientUser.userId = req.user.id

    return res.json({
      success: true,
      user: clientUser
    });

  } else {
    return res.json({
      success: false
    });
  }
}

/**
 * The fields of a user the client is allowed to see.
 *
 * An allow-list, not a subtraction: everything not named here stays on the
 * server. That is what keeps the password hash, the reset token and the confirm
 * token out of a login response without anyone having to remember to remove
 * them when a field is added to the schema.
 */
function clientProfile(user) {
  return {
    firstName: user.firstName,
    lastName: user.lastName,
    screenName: user.screenName,
    callsign: user.callsign,
    city: user.city,
    state: user.state,
    country: user.country,
    email: user.email,
    admin: user.admin,
    plan: user.plan,
    terms: user.terms,
    userId: user.id
  };
}

/**
 * What the visitor is told when sign-in fails.
 *
 * The audit trail gets the precise reason; the visitor does not. "bad password"
 * and "no such account" are deliberately collapsed back to one answer, because
 * telling them apart is exactly how an attacker works out which addresses have
 * accounts. They were both "invalid" before the audit trail split them, and to
 * the client they still are.
 */
function rejectionResponse(info) {
  const publicReason = (info.reason === "bad password" || info.reason === "no such account")
    ? "invalid"
    : info.reason;

  const failure = {
    success: false,
    message: info.message,
    reason: publicReason
  };
  // userId only for an unconfirmed address, so the resend flow has something to
  // act on. Deliberately not for a wrong password: that answer is worded
  // identically to "no such account" so it cannot be used to discover which
  // addresses have accounts, and returning an id here would give that away.
  if (info && info.reason === "unconfirmed email" && info.userId) {
    failure.userId = info.userId;
  }
  return failure;
}

/** The strategy rejected the credentials. Record it, then answer. */
function refuseSignIn(req, res, info) {
  console.log("No user");
  // Every rejection is recorded, with the reason the strategy gave. The
  // strategy passes userId along when the account exists, so the trail can tell
  // a wrong password on a real account apart from a guessed address.
  loginEvents.record(req, {
    success: false,
    reason: info && info.reason ? info.reason : "no such account",
    email: req.body.email,
    userId: info && info.userId,
    callsign: info && info.callsign
  });
  return res.json(rejectionResponse(info));
}

/**
 * Defence in depth: the strategy already rejects an unconfirmed address before
 * it checks the password, so nothing reaches this today. It exists so that
 * moving or removing that check cannot quietly let an unconfirmed account in.
 */
function refuseUnconfirmed(req, res, next, user) {
  // Only the callback form. Since passport 0.6 a bare req.logout() throws
  // "req#logout requires a callback function" whenever a session manager is
  // attached, which it always is here - and this sits inside a req.login
  // callback, so the throw escapes as an uncaught exception rather than
  // reaching the error handler. Signing in with an unconfirmed address took
  // down the account process.
  return req.logout(function (err) {
    if (err) { return next(err); }
    res.clearCookie('sessionId', { domain: cookie_domain, path: '/' });
    return res.json({
      success: false,
      message: "unconfirmed email",
      reason: "unconfirmed email",
      userId: user.id
    });
  });
}

/** The session is established. Record it, stamp it, and answer. */
function completeSignIn(req, res, user) {
  // When this session was actually authenticated. Listener sessions roll for
  // 30 days, but admin routes require a login within the last 12 hours, so the
  // age of the login has to be recorded separately from the session.
  req.session.loginAt = Date.now();

  loginEvents.record(req, {
    success: true,
    reason: "ok",
    email: user.email,
    callsign: user.callsign,
    userId: user.id
  });

  // lastLogin had a default of Date.now and was then never written again, so it
  // recorded when the account was created. The admin portal shows it as "last
  // login", so it needs to actually mean that. Fire and forget - a failure here
  // should not fail the login.
  User.updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } })
    .catch(err => console.error("Error - could not stamp lastLogin: " + err));

  return res.json({
    success: true,
    message: "authentication succeeded",
    user: clientProfile(user),
    userId: user.id
  });
}

exports.login = function (req, res, next) {
  // A custom callback, so establishing the session and sending the response are
  // this function's job rather than passport's:
  // http://passportjs.org/docs
  passport.authenticate("local", function (err, user, info) {
    if (err) return next(err);
    if (!user) return refuseSignIn(req, res, info);

    req.login(user, loginErr => {
      if (loginErr) {
        console.log("error")
        return res.json({
          success: false,
          message: loginErr
        });
      }
      if (!user.confirmEmail) return refuseUnconfirmed(req, res, next, user);
      return completeSignIn(req, res, user);
    });
  })(req, res, next);
};

exports.confirmEmail = async function (req, res, next) {
  const userId = req.params["userId"];
  const token = req.params["token"];

  let user = await User.findById(userId).catch(err => {
    console.error(err);
    res.status(404);
    res.json({
      success: false,
      message: err
    });
    return;
  });

  if (!user) {
    console.error("User not found: " + userId);
    res.status(404);
    res.json({
      success: false,
      message: "User not found"
    });
    return;
  }
  if (user.confirmEmail) {
    console.log("User already confirmed email: " + userId);
    res.status(500);
    res.json({
      success: false,
      message: "already confirmed email"
    });
    return;
  }
  const today = new Date();
  // The `!user.confirmEmailTTL` half matters: when the field is unset the
  // comparison alone is `undefined < today`, which is false, so the expiry check
  // passed. Nothing got through, because the token check below rejects an unset
  // token - but that made this check load-bearing on the next one rather than on
  // its own terms.
  if (!user.confirmEmailTTL || user.confirmEmailTTL < today) {
    res.status(400);
    console.error("Expired token for confirming email: " + userId);
    res.json({
      success: false,
      message: "token expired"
    });
    return;
  }
  if (!tokensMatch(token, user.confirmEmailToken)) {
    // Never log either token. This used to print the value currently valid in
    // the database, and logs go to syslog and are kept - which turned every
    // mistyped link into a durable record of a live credential.
    res.status(400);
    console.error("Token mismatch confirming email for user: " + userId);
    res.json({
      success: false,
      message: "token mismatch"
    });
    return;
  }
  user.confirmEmail = true;
  user.confirmEmailToken = "";
  await user.save().catch(err => {
    console.error(err);
    res.status(500);
    res.json({
      success: false,
      message: err
    });
    return;
  });

  console.log("User: " + user.email + " confirmed email address");
  res.json({
    success: true
  });
};


exports.resetPassword = async function (req, res, next) {
  const userId = req.params["userId"];
  const token = req.params["token"];

  let user = await User.findById(userId).catch(err => {
    console.error(err);
    res.status(500);
    res.json({
      success: false,
      message: err
    });
    return;
  });

  if (!user) {
    console.error("User not found: " + userId);
    res.status(404);
    res.json({
      success: false,
      message: "User not found"
    });
    return;
  }
  const today = new Date();
  // See the note on confirmEmail above - an unset TTL made this comparison
  // `undefined < today`, which is false, so the expiry check passed on its own.
  if (!user.resetPasswordTTL || user.resetPasswordTTL < today) {
    res.status(400);
    res.json({
      success: false,
      message: "token expired"
    });
    return;
  }
  if (!tokensMatch(token, user.resetPasswordToken)) {
    // Never log either token. A reset token is valid for 24 hours and is a full
    // account takeover; this used to print the live one from the database.
    console.error("Token mismatch resetting password for user: " + userId);
    res.status(400);
    res.json({
      success: false,
      message: "token mismatch"
    });
    return;
  }

  user.password = req.body.password
  user.confirmEmail = true;
  user.confirmEmailToken = "";
  user.resetPasswordToken = "";
  // Cleared alongside the token. Leaving it set left the account in a "valid
  // TTL, empty token" state for the rest of the day, which is only harmless
  // because tokensMatch refuses an empty stored token.
  user.resetPasswordTTL = undefined;
  await user.save().catch(err => {
    console.error(err);
    res.json({
      success: false,
      message: err
    });
    return;
  });
  res.json({
    success: true
  });
  return;
};


// -------------------------------------------
exports.sendResetPassword = async function (req, res, next) {
  let user = await User.findOne({
    email: { '$regex': escapeRegExp(req.body.email), $options: 'i' } 
  }).catch(err => {
    console.error(err);
    res.status(500);
    res.json({
      success: false,
      message: err
    });
    return;
  });
  if (!user) {
    // Answers exactly as it does for an address that does exist. Saying "no
    // account registered for X" turned this into a free check for whether any
    // given email has an account here. The caller sees the same "check your
    // email" screen either way; only the log knows the difference.
    console.error("Reset password requested for an address with no account: " + req.body.email);
    res.json({
      success: true
    });
    return;
  }
  const buffer = crypto.randomBytes(20);
  const token = buffer.toString("hex");
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  user.resetPasswordToken = token;
  user.resetPasswordTTL = tomorrow;
  await user.save().catch(err => {
    console.error(err);
    res.status(500);
    res.json({
      success: false,
      message: err
    });
    return;
  });

  const request = mailjet.post("send", {
    version: "v3.1"
  }).request({
    Messages: [{
      From: {
        Email: admin_email,
        Name: site_name + " Admin"
      },
      To: [{
        Email: user.email,
        Name: user.firstName + " " + user.lastName
      }],
      Subject: site_name + " - Password Reset",
      TextPart: "It looks like you may have forgot your password. Copy this link to your browser to reset your password. Let us know if you are receiving this but did not request a password reset. /r" + account_server + "/reset-password/" + user.id + "/" + token,
      HTMLPart: "<h3>Thanks for using " + site_name + "!</h3><br />It looks like you may have forgot your password. Copy this link to your browser to reset your password. Let us know if you are receiving this but did not request a password reset.<p>" + account_server + "/reset-password/" + user.id + "/" + token + "</p>"
    }]
  });
  request
    .then(result => {
      console.log(`Password reset sent to: ${user.email}`)
    })
    .catch(err => {
      console.error(err.statusCode);
      console.error(err);
      res.json({
        success: false,
        message: err
      });
      return;
    });
  res.json({
    success: true
  });
  return;
};

function handleSendConfirmEmail(user) {

  return new Promise(async (resolve, reject) => {
    if (user.confirmEmail) {
      console.log("Error - Send Confirm Email - User already confirmed email: " + user.email);
      reject({
        success: false,
        message: "already confirmed email"
      });
      return;
    }

    const buffer = crypto.randomBytes(20);
    const token = buffer.toString("hex");
    var tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    user.confirmEmailToken = token;
    user.confirmEmailTTL = tomorrow;
    await user.save();
    mailjet.post("send", {
      version: "v3.1"
    }).request({
      Messages: [{
        From: {
          Email: admin_email,
          Name: site_name + " Admin"
        },
        To: [{
          Email: user.email,
          Name: user.firstName + " " + user.lastName
        }],
        Subject: "Confirm " + site_name + " Account",
        TextPart: "Thanks for signing up for " + site_name + ". We just wanted to check and make sure your email address was real. Copy and paste this addres in your browser to confirm your email address: " + account_server + "/confirm-email/" + user._id + "/" + token,
        HTMLPart: "<h3>Thanks for signing up for " + site_name + "</h3><br />We just wanted to check and make sure your email address was real. Copy and paste this addres in your browser to confirm your email address:<p> " + account_server + "/confirm-email/" + user._id + "/" + token + "</p>"
      }]
    }).then(result => {
      console.log("Confirm email sent to: " + user.email);
      resolve({
        success: true,
        userId: user._id
      });
    }).catch(err => {
      console.error("Admin Email: " + admin_email + " User Email: " + user.email);
      console.error("Error - Send Confirm Email - caught: " + err);
      // Two crashes used to happen here whenever Mailjet returned an error:
      //  1. `res.status(500)` - there is no `res` in this scope, since
      //     handleSendConfirmEmail only takes `user`. The ReferenceError
      //     escaped as an unhandled rejection and killed the process.
      //  2. Rejecting with the raw Mailjet error. It holds circular
      //     references, so the callers' res.json() threw inside
      //     JSON.stringify - again crashing the process.
      // Both callers .catch() this and build their own response, so reject
      // with a plain serialisable message.
      reject({
        success: false,
        message: err && err.message ? err.message : String(err)
      });
    });
  });
}

// -------------------------------------------
exports.sendConfirmEmail = async function (req, res, next) {
  const userId = req.params["userId"];
  let user = await User.findById(userId).catch(err => {

    console.error("Error - Send Confirm Email: " + err);
    res.status(500);
    res.json({
      success: false,
      message: err
    });
    return;
  });
  if (!user) {
    console.error("Error - Send Confirm Email: User not found " + userId);
    res.status(404);
    res.json({
      success: false,
      message: "user not found"
    });
    return;
  }
  handleSendConfirmEmail(user).then(function (result) {
    res.json(result);
    return;
  }).catch(function (error) {
    res.json(error);
    return;
  });
}



// -------------------------------------------

exports.logout = function (req, res, next) {
  // the logout method is added to the request object automatically by Passport
  req.logout(function (err) {
    if (err) { return next(err); }

    res.clearCookie('sessionId', { domain: cookie_domain, path: '/' });
    return res.json({
      success: true
    });
  });
};

exports.terms = async function (req, res, next) {
  const userId = req.params["userId"];
  let user = await User.findById(userId).catch(err => {
    console.error(err);
    res.status(500);
    res.json({
      success: false,
      message: err
    });
    return;
  });

  if (req.user.id != userId) {
    console.log(
      "Logged in user's ID: " +
      req.user.id +
      " does not match Param: " +
      userId
    );
    res.status(500);
    res.json({
      success: false,
      message: "UserID incorrect"
    });
    return;
  }

  user.terms = 1.1; //User.termsVer;
  await user.save().catch(err => {

    console.error(err);
    res.status(500);
    res.json({
      success: false,
      message: err
    });
    return;
  });
  var clientUser = (({
    terms
  }) => ({
    terms
  }))(
    user
  );
  res.json({
    success: true,
    user: clientUser
  });
  return;
}
// -------------------------------------------


exports.validateProfile = function (req, res, next) {
  console.log("Validating user profile: " + req.body.email);
  if (!req.body.firstName || (req.body.firstName.length < 2)) {
    console.error("ERROR: Validate System - req.body.firstName");
    res.json({
      success: false,
      message: "First Name is Required"
    });
    return;
  }
  res.locals.firstName = req.body.firstName.replace(/[^\w\s\.\,\-\'\`]/gi, '');

  if (!req.body.lastName || (req.body.lastName.length < 2)) {
    console.error("ERROR: Validate System - req.body.lastName");
    res.json({
      success: false,
      message: "Last Name is Required"
    });
    return;
  }
  res.locals.lastName = req.body.lastName.replace(/[^\w\s\.\,\-\'\`]/gi, '');

  // The callsign is the account's public identity, and screenName is derived
  // from it on save. Stored lowercase so the unique index matches
  // case-insensitively; the UI uppercases it for display.
  if (!req.body.callsign) {
    console.error("ERROR: Validate Profile - req.body.callsign");
    res.json({
      success: false,
      message: "Callsign is Required"
    });
    return;
  }
  const callsign = req.body.callsign.trim().toLowerCase();
  if (!/^[a-z0-9]{3,7}$/.test(callsign)) {
    console.error("ERROR: Validate Profile - callsign format: " + callsign);
    res.json({
      success: false,
      message: "Callsign must be 3 to 7 letters and numbers, with no spaces or punctuation"
    });
    return;
  }
  res.locals.callsign = callsign;

  if (!req.body.city || (req.body.city.length < 2)) {
    console.error("ERROR: Validate Profile - req.body.city");
    res.json({
      success: false,
      message: "City is Required"
    });
    return;
  }
  res.locals.city = req.body.city.replace(/[^\w\s\.\,\-\'\`]/gi, '');

  // State, province or region is optional - much of the world has no equivalent.
  res.locals.state = req.body.state ? req.body.state.replace(/[^\w\s\.\,\-\'\`]/gi, '') : "";

  if (!req.body.country || (req.body.country.length < 2)) {
    console.error("ERROR: Validate Profile - req.body.country");
    res.json({
      success: false,
      message: "Country is Required"
    });
    return;
  }
  res.locals.country = req.body.country.replace(/[^\w\s\.\,\-\'\`]/gi, '');

  next();
}

exports.updateProfile = async function (req, res, next) {
  const userId = req.params["userId"];

  user = await User.findById(userId).catch(err => {
    console.error(err);
    res.status(500);
    res.json({
      success: false,
      message: err
    });
    return;
  });

  if (req.user.id != userId) {
    console.log(
      "ERROR: Logged in user's ID: " +
      req.user.id +
      " does not match Param: " +
      userId
    );
    res.json({
      success: false,
      message: "UserID incorrect"
    });
    return;
  }

  // Lets make sure someone else isn't using this callsign. Both sides are
  // stored lowercase, so this is a plain equality check rather than a regex.
  const callsignUser = await User.findOne({ callsign: res.locals.callsign }).catch(err => {
    console.error(err);
    res.status(500);
    res.json({
      success: false,
      message: err
    });
    return;
  });

  // Did we find a user with this callsign, and is it not us? Compare _id -
  // User documents have no userId field, so the previous comparison was always
  // false and let the unique index fail the save instead.
  if (callsignUser && !callsignUser._id.equals(user._id)) {
    res.status(500);
    res.json({
      success: false,
      message: "Callsign already in use"
    });
    return;
  }



  // go ahead and create the new user
  user.firstName = res.locals.firstName
  user.lastName = res.locals.lastName
  user.callsign = res.locals.callsign
  user.city = res.locals.city
  user.state = res.locals.state
  user.country = res.locals.country


  await user.save().catch(err => {
    console.error(err);
    res.json({
      success: false,
      message: err
    });
    return;
  });
  var clientUser = (({
    firstName,
    lastName,
    screenName,
    callsign,
    city,
    state,
    country
  }) => ({
    firstName,
    lastName,
    screenName,
    callsign,
    city,
    state,
    country
  }))(
    user
  );
  console.log("Updated Profile: " + userId)
  res.json({
    success: true,
    user: clientUser
  });
  return;
};
// -------------------------------------------

exports.register = async function (req, res, next) {
  console.log("Registration request for: " + req.body.email);

  let user = await User.findOne({
    $or: [{
			email: { '$regex': escapeRegExp(req.body.email), $options: 'i' } 
		}, {
			local: {
				email: { '$regex': escapeRegExp(req.body.email), $options: 'i' } 
			}
		}]
  }).catch(err => {
    console.error(err);
    res.status(500);
    res.json({
      success: false,
      message: err
    });
    return;
  });
  // is email address already in use?
  if (user) {
    res.status(500);
    res.json({
      success: false,
      message: "Email already in use"
    });
    return;
  }
  // res.locals.callsign is already normalized to lowercase by validateProfile,
  // and the stored value is lowercase too, so this compares like for like.
  user = await User.findOne({ callsign: res.locals.callsign }).catch(err => {
    console.error(err);
    res.status(500);
    res.json({
      success: false,
      message: err
    });
    return;
  });
  // is the callsign already claimed?
  if (user) {
    res.status(500);
    res.json({
      success: false,
      message: "Callsign already in use"
    });
    return;
  }
  // go ahead and create the new user. screenName is not taken from input - the
  // model derives it from the callsign on save.
  user = (({
    firstName,
    lastName,
    callsign,
    city,
    state,
    country
  }) => ({
    firstName,
    lastName,
    callsign,
    city,
    state,
    country
  }))(
    res.locals
  );
  user.password = req.body.password;
  user.email = req.body.email;

  let savedUser = await User.create(user)

  console.log("Successfully registered: " + user.email + ", now sending confirmation email.");
  // Since registration worked, send a confirmation email.
  handleSendConfirmEmail(savedUser).then(function (result) {
    console.log("Confirmation email sent to: " + user.email);
    res.json({
      success: true,
      message: result
    });
    return;
  }).catch(function (err) {
    console.error("Error creating user: " + user.email + " Error: " + err);
    res.json({
      success: false,
      message: err
    });
    return;
  });
}