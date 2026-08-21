/**
 * Listener gate.
 *
 * The account service authenticates people; passport stores the user id on the
 * session as session.passport.user. All the backend has to do is read it back
 * and confirm the account is still real and still confirmed.
 *
 * Deliberately not used on /:shortName/upload - trunk-recorder is a headless
 * client that cannot hold a cookie, and authenticates with its API key instead.
 */
const crypto = require("crypto");

const User = require("../models/user");

/**
 * Constant-time comparison of a submitted system API key against the stored one.
 *
 * Both callers - controllers/uploads.js and controllers/systems.js - used `!==`
 * and `!=`, which return as soon as two bytes differ and so leak how much of a
 * guess was right. Over the internet that signal is buried in jitter, so this is
 * closing a theoretical gap rather than a live one; it costs nothing.
 *
 * timingSafeEqual throws unless both buffers are the same length, and the length
 * of the stored key is not a secret worth protecting (they are all 32 hex
 * characters from crypto.randomBytes(16)), so an early length check is fine.
 *
 * Note what this does NOT fix: keys are still stored in plaintext, so anyone who
 * can read the database has them outright. That is the substantive half, and
 * hashing them is a product decision - owners could no longer retrieve a lost
 * key from the admin portal, only regenerate it.
 */
function keysMatch(submitted, stored) {
  if (typeof submitted !== "string" || typeof stored !== "string") return false;
  // Both empty is the case worth spelling out: timingSafeEqual answers true for
  // two zero-length buffers, so without this a system whose key was never set
  // could be opened by sending an empty one.
  if (submitted.length === 0 || stored.length === 0) return false;
  if (submitted.length !== stored.length) return false;
  return crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(stored));
}

exports.keysMatch = keysMatch;

function deny(res, message, reason) {
  res.status(401);
  res.contentType('json');
  res.send(JSON.stringify({
    success: false,
    message: message,
    reason: reason
  }));
}

/**
 * Returns the signed-in user, or null. Shared by the HTTP gate and the
 * Socket.IO handshake so both apply the same rules.
 */
async function resolveListener(session) {
  const userId = session && session.passport && session.passport.user;
  if (!userId) {
    return { error: "Sign in to listen", reason: "unauthenticated" };
  }

  // `plan` must stay in this projection. Leaving it out does not error - it
  // just makes req.listener.plan undefined, so every Supporter silently reads
  // as a free account and the gated features quietly stop working for everyone.
  const user = await User.findById(userId, "email confirmEmail admin disabled plan callsign screenName");
  if (!user) {
    // The session outlived the account - treat it as signed out rather than
    // leaving a ghost session that half works.
    return { error: "Sign in to listen", reason: "unauthenticated" };
  }
  // Checked on every request rather than only at login, so disabling an account
  // in the admin portal takes effect immediately instead of whenever their
  // 30-day session happens to lapse.
  if (user.disabled) {
    return { error: "This account has been disabled", reason: "disabled" };
  }
  if (!user.confirmEmail) {
    return { error: "Confirm your email address to listen", reason: "unconfirmed email" };
  }

  return { user: user };
}

exports.resolveListener = resolveListener;

exports.requireListener = async function (req, res, next) {
  let result;
  try {
    result = await resolveListener(req.session);
  } catch (err) {
    console.error("Error resolving listener session: " + err);
    res.status(500);
    res.contentType('json');
    res.send(JSON.stringify({ success: false, message: "Could not verify session" }));
    return;
  }

  if (result.error) {
    return deny(res, result.error, result.reason);
  }

  req.listener = result.user;
  next();
};
