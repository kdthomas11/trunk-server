const fs = require("fs");
const express = require("express");
const mongoose = require("mongoose");
const passport = require("passport");
const path = require("path");
const secrets = require("./config/secrets");
const configurePassport = require("./config/passport");
const configureExpress = require("./config/express");
const users = require("./controllers/users");
const limits = require("./config/rate-limits");
require("./models/user");
require("./models/login_event");

// -------------------------------------------

const app = express()

// -------------------------------------------

const connect = async () => {

	// Demonstrate the readyState and on event emitters
	console.log(mongoose.connection.readyState); //logs 0
	mongoose.connection.on('connecting', () => {
		console.log('Mongoose is connecting')
		console.log(mongoose.connection.readyState); //logs 2
	});
	mongoose.connection.on('connected', () => {
		console.log('Mongoose is connected');
		console.log(mongoose.connection.readyState); //logs 1
	});
	mongoose.connection.on('disconnecting', () => {
		console.log('Mongoose is disconnecting');
		console.log(mongoose.connection.readyState); // logs 3
	});

	// Connect to a MongoDB server running on 'localhost:27017' and use the
	// 'test' database.
	await mongoose.connect(secrets.db, { useNewUrlParser: true, useUnifiedTopology: true }).catch(err => {

		console.error(`Mongoose - Error connecting to ${secrets.db}. ${err}`)

	});
	console.log("All Done");
}

connect();

mongoose.connection.on('error', err => {
	console.error("Mongoose Error!")
	console.error(err);
});
mongoose.connection.on('disconnected', () => {
	console.log('Mongoose disconnected');
	console.log(mongoose.connection.readyState); //logs 0
	connect();
});

// -------------------------------------------

const isDev = process.env.NODE_ENV === "development"




var frontend_server = process.env['REACT_APP_FRONTEND_SERVER'] != null ? process.env['REACT_APP_FRONTEND_SERVER'] : 'https://hamrecorder.com';
var account_server = process.env['REACT_APP_ACCOUNT_SERVER'] != null ? process.env['REACT_APP_ACCOUNT_SERVER'] : 'https://account.hamrecorder.com'; //'https://s3.amazonaws.com/robotastic';
var admin_server = process.env['REACT_APP_ADMIN_SERVER'] != null ? process.env['REACT_APP_ADMIN_SERVER'] : 'https://admin.hamrecorder.com'; //'https://s3.amazonaws.com/robotastic';


// -------------------------------------------

configurePassport(app, passport)
configureExpress(app, passport)


// A second CORS handler used to sit here, running after the one in
// config/express.js and partly undoing it. It echoed the origin from a narrower
// list (no dev servers), overwrote Access-Control-Allow-Headers, never set
// Vary: Origin, and set Access-Control-Allow-Credentials unconditionally - so an
// origin the first handler had just refused got that header back anyway.
//
// Deleted rather than reconciled. config/express.js does this once, for a
// superset of these origins, and is the copy kept in step with the backend and
// admin services. Two handlers meant the effective policy was whichever ran
// last, which is not something anyone should have to work out from the source.

// -------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.post("/login", limits.loginLimiter, users.login)
app.get("/logout", users.logout)
app.get("/authenticated", users.authenticated)
app.post("/register", limits.registerLimiter, users.validateProfile, users.register)
app.post("/users/:userId/reset-password/:token", users.resetPassword)
app.post("/api/send-reset-password", limits.resetPasswordLimiter, users.sendResetPassword)
app.post("/users/:userId", users.isLoggedIn, users.validateProfile, users.updateProfile)
app.post("/users/:userId/terms", users.isLoggedIn, users.terms)
app.post("/users/:userId/send-confirm", limits.confirmEmailLimiter, users.sendConfirmEmail)
app.post("/users/:userId/confirm/:token", users.confirmEmail)

app.get("*", (req, res, next) => {
	res.sendFile(__dirname + '/public/index.html');
});


// start listening to incoming requests
app.listen(app.get("port"), app.get("host"), (err) => {
	if (err) {
		console.err(err.stack)
	} else {
		console.log(`App listening on port ${app.get("port")} [${process.env.NODE_ENV} mode]`)
	}
})
