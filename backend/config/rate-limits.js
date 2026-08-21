/**
 * Rate limits for the endpoints anyone can reach without a session.
 *
 * The backend had none. Two endpoints took no authentication at all:
 *
 *   POST /:shortName/contact    sends mail, through our Mailjet account, to
 *                               the system owner and the admin address. No
 *                               session, no cap on how often or how long.
 *   POST /:shortName/authorize  answers 200 for a valid system API key and 403
 *                               for a bad one, as fast as you can ask.
 *
 * Contact is now behind requireListener as well, so the limiter here is the
 * second line rather than the only one. Authorize cannot be - trunk-recorder
 * calls it at startup with no cookie to offer - so for that endpoint this is
 * the only brake in the application.
 *
 * Counting is in memory, per container. Same tradeoff the account service
 * documents: fine at one container, needs a shared store if this is ever scaled
 * out. These are a brake on automation, not a security boundary - the boundary
 * is requireListener and the API key itself.
 *
 * A near-copy of account/server/config/rate-limits.js. The two services are
 * separate Docker build contexts, so a shared module would have to be published
 * or the images restructured; until then this is duplicated on purpose, the
 * same way test/run.js is.
 */
const rateLimit = require("express-rate-limit");

const MINUTE = 60 * 1000;

function limiter(options) {
  return rateLimit({
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // The JSON shape every client here already understands. Without this,
    // express-rate-limit answers with plain text.
    handler: (req, res) => {
      res.status(429).json({
        success: false,
        message: options.message,
        reason: "rate limited"
      });
    },
    ...options
  });
}

/**
 * Keyed on the system being mailed, not the caller's IP.
 *
 * The abuse this stops is mailing one owner over and over, which a botnet could
 * do from a different address each time. Keying this way also means a busy day
 * across many different systems is never mistaken for it. Per-IP throttling is
 * nginx's job - see limit_req in the vhost templates.
 *
 * Five an hour is far more than a real person reporting a problem with a feed
 * needs, and useless for filling somebody's inbox.
 */
exports.contactLimiter = limiter({
  windowMs: 60 * MINUTE,
  limit: 5,
  keyGenerator: (req) => `contact:${String(req.params.shortName).toLowerCase()}`,
  message: "This system has been sent several messages already. Try again in an hour."
});

/**
 * Keyed on the caller, because this one is about guessing rather than mailing.
 *
 * Keys are 128 bits of crypto.randomBytes, so this was never a practical way to
 * recover one. What it was is a free, unlimited oracle for checking a key found
 * somewhere else, and for enumerating which shortNames exist. Thirty an hour
 * leaves trunk-recorder's startup check alone - it runs once per restart - and
 * takes the oracle away.
 */
exports.authorizeLimiter = limiter({
  windowMs: 60 * MINUTE,
  limit: 30,
  message: "Too many authorization attempts. Try again in an hour."
});
