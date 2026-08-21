const path = require("path");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const MongoStore = require("connect-mongo");
const secrets = require("./secrets");

var cookie_domain = process.env['REACT_APP_COOKIE_DOMAIN'] != null ? process.env['REACT_APP_COOKIE_DOMAIN'] : '.hamrecorder.com'; //'https://s3.amazonaws.com/robotastic';
var backend_server = process.env['REACT_APP_BACKEND_SERVER'] != null ? process.env['REACT_APP_BACKEND_SERVER'] : 'https://api.hamrecorder.com';
var frontend_server = process.env['REACT_APP_FRONTEND_SERVER'] != null ? process.env['REACT_APP_FRONTEND_SERVER'] : 'https://hamrecorder.com';
var account_server = process.env['REACT_APP_ACCOUNT_SERVER'] != null ? process.env['REACT_APP_ACCOUNT_SERVER'] : 'https://account.hamrecorder.com'; //'https://s3.amazonaws.com/robotastic';
var admin_server = process.env['REACT_APP_ADMIN_SERVER'] != null ? process.env['REACT_APP_ADMIN_SERVER'] : 'https://admin.hamrecorder.com';
var account_dev_server = "http://account.hamrecorder.test:3000"
var admin_dev_server = "http://admin.hamrecorder.test:3000"

module.exports = function(app, passport) {
	app.set("port", 3009)

	// X-Powered-By header has no functional value.
	// Keeping it makes it easier for an attacker to build the site's profile
	// It can be removed safely
	app.disable("x-powered-by")
	// One hop, not "trust anything". nginx is the only proxy in front of this,
	// so req.ip is the address nginx saw. With the previous `true`, a client
	// could put any address it liked in X-Forwarded-For and have express believe
	// it - which would let it spoof both the rate limiter's key and the IP in
	// the login audit trail.
	app.set('trust proxy', 1)
	app.use(bodyParser.json())
	app.use(bodyParser.urlencoded({ extended: true }))
	app.use(express.static(path.join(process.cwd(), 'public')));

	// Rolling, so 30 days measures inactivity rather than age: someone who keeps
	// listening is never signed out, someone who stops is asked to sign in again
	// after a month. The store ttl matches so the sessions collection expires in
	// step. These settings must stay identical to admin and backend.
	const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
	const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;

	const sess = {
		resave: false,
		saveUninitialized: false,
		secret: secrets.sessionSecret,
		proxy: true,
		rolling: true,
		name: "sessionId",
		cookie: {
			httpOnly: true,
			secure: false,
			sameSite: 'lax',
			domain: cookie_domain,
			maxAge: THIRTY_DAYS_MS
		},
		store:  MongoStore.create({
			mongoUrl: secrets.db,
			ttl: THIRTY_DAYS_SEC,
			autoReconnect: true,
			autoRemove: 'interval',
			autoRemoveInterval: 240,
			touchAfter: 24 * 3600 // time period in seconds
		})
	}

	var node_env = process.env.NODE_ENV;
	console.log('--------------------------');
	console.log('===> 😊  Starting Server . . .');
	console.log('===>  Environment: ' + node_env);
	if(node_env === 'production') {
		console.log('===> 🚦  Note: In order for authentication to work in production');
		console.log('===>           you will need a secure HTTPS connection');
		sess.cookie.secure = true; // Serve secure cookies
	}

	app.use(session(sess))

	app.use(passport.initialize())
	app.use(passport.session())
	
	app.use('/*', function(req, res, next) {
	    var allowedOrigins = [ account_server];
	    allowedOrigins.push(frontend_server);
	    allowedOrigins.push(backend_server);
		allowedOrigins.push(admin_server);
		allowedOrigins.push(admin_dev_server);
		allowedOrigins.push(account_dev_server);
	    var origin = req.headers.origin;


	    // Same shape as backend/config/express.js, which was corrected first.
	    //
	    // This answered "*" for anything unrecognised, alongside
	    // Allow-Credentials: true. Browsers reject that pair outright on a
	    // credentialed request, so it was never a way in - but it meant a real
	    // CORS misconfiguration looked identical to a working one, with only a
	    // "forcing CORS" line in the log to tell them apart. An unknown origin
	    // now gets no CORS headers at all, which is the honest answer.
	    //
	    // The TrunkRecorder1.0 branch goes with it: it keyed off a user-agent,
	    // which the caller writes, so it granted nothing the wildcard was not
	    // already granting everyone. trunk-recorder is not a browser and is not
	    // subject to CORS in the first place.
	    if (allowedOrigins.indexOf(origin) > -1) {
	        res.setHeader('Access-Control-Allow-Origin', origin);
	        // Required whenever the origin is echoed rather than fixed. Without
	        // it a shared cache can hand one origin's response, Allow-Origin
	        // header and all, to a different origin.
	        res.setHeader('Vary', 'Origin');
	        res.header('Access-Control-Allow-Credentials', 'true');
	    } else if (origin) {
	        console.warn("blocked CORS for: " + origin + " referer: " + req.headers.referer);
	    }
	    // Requests with no Origin header - curl, server to server - are not
	    // subject to CORS and need none of this.

		res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
	    res.header("Access-Control-Allow-Headers", "Origin, Accept, X-Requested-With, Content-Type, Access-Control-Request-Method, Access-Control-Request-Headers");
	    res.header('Access-Control-Max-Age', '600');

	    // Preflights end here. Credentialed cross-origin requests trigger them,
	    // and they were previously falling through to the catch-all route.
	    if (req.method === 'OPTIONS') {
	        return res.sendStatus(204);
	    }
	    next();
	});



}
