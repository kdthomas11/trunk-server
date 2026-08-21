var mongoose = require("mongoose");
var User = require("../models/user");
var System = require("../models/system");
const { keysMatch } = require("../middleware/auth");
const Mailjet = require('node-mailjet');
var schedule = require('node-schedule');

var admin_email = process.env['REACT_APP_ADMIN_EMAIL'] != null ? process.env['REACT_APP_ADMIN_EMAIL'] : "admin@hamrecorder.com";
var admin_server = process.env['REACT_APP_ADMIN_SERVER'] != null ? process.env['REACT_APP_ADMIN_SERVER'] : "https://admin.hamrecorder.com";
var site_name = process.env['REACT_APP_SITE_NAME'] != null ? process.env['REACT_APP_SITE_NAME'] : "HamRecorder";

const mailjet = new Mailjet({
  apiKey: process.env['MAILJET_KEY'],
  apiSecret: process.env['MAILJET_SECRET']
});

var systemList = [];

// The contact form's fields were passed straight into a Mailjet send with no
// length check, so a caller decided how much mail left our account and how big
// each message was. These are generous for someone reporting a problem with a
// feed and small enough that the endpoint is not worth using as a pipe.
const MAX_NAME = 100;
const MAX_EMAIL = 254;   // the longest address RFC 5321 allows
const MAX_MESSAGE = 2000;

// Deliberately loose. This is not validating that the address exists - it is
// refusing the shapes that have no business in a From/ReplyTo header, notably
// anything carrying a newline. Mailjet's JSON API is not raw SMTP, so this is
// belt and braces rather than the only thing standing between us and header
// injection.
const EMAIL_SHAPE = /^[^\s@,;:<>"]+@[^\s@,;:<>"]+\.[^\s@,;:<>"]+$/;

/**
 * Returns a trimmed string, or null when the field is missing, empty, not a
 * string, or longer than max. Body fields arrive as whatever the sender chose -
 * an array or an object here would otherwise reach the mail template.
 */
function field(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

exports.contact_system = async function (req, res) {
  const senderName = field(req.body.name, MAX_NAME);
  const senderEmail = field(req.body.email, MAX_EMAIL);
  const senderMessage = field(req.body.message, MAX_MESSAGE);

  if (!senderName || !senderEmail || !senderMessage || !EMAIL_SHAPE.test(senderEmail)) {
    res.status(400);
    res.json({
      success: false,
      message: "Please provide your name, a valid email address, and a message."
    });
    return;
  }

  var system = await System.findOne({
    shortName: req.params.shortName.toLowerCase()
  }).catch(err => {
    res.status(500);
    res.json({
      success: false,
      message: err
    });
    return;
  });
  if (!system) {
    console.error("[contact_system] The Short Name does not exist: " + req.params.shortName.toLowerCase());
    res.status(500);
    res.json({
      success: false,
      message: "That Short Name does not exist."
    });
    return;
  }
  if (!system.allowContact) {
    console.error("[contact_system] This System does not allow user to contact the owner: " + req.params.shortName.toLowerCase());
    res.status(500);
    res.json({
      success: false,
      message: "This System does not allow user to contact the owner."
    });
    return;
  }
  const user = await User.findById(system.userId).exec();
  if (!user) {
    console.error("[contact_system] System User does not exist: " + req.params.shortName.toLowerCase());
    res.status(500);
    res.json({
      success: false,
      message: "System User does not exist."
    });
    return;
  }

  let message = "Thank you for contributing a feed to " + site_name + ". A user has sent in a message about this feed:\n\n-------------------------------\n"
  message = message + "User Name: " + senderName + "\n";
  message = message + "User Email: " + senderEmail + "\n-------------------------------\n";
  message = message + "Message:\n" + senderMessage + "\n-------------------------------\n\n";
  message = message + "If you wish to stop receiving User Messages for this System:\n - goto the Admin for " + site_name + ": " + admin_server + "\n - find this System\n - Update it and turn off this Allow Contact option."
  const request = mailjet.post("send", {
    version: "v3.1"
  }).request({
    Messages: [{
      From: {
        Email: admin_email,
        Name: site_name + " Admin"
      },
      ReplyTo: {
        Email: senderEmail,
        Name: senderName
      },
      To: [{
        Email: user.email,
        Name: user.firstName + " " + user.lastName
      }, {
        Email: admin_email,
        Name: site_name + " Admin"
      }],
      Subject: site_name + " - " + system.shortName + " - " + " User Comment",
      TextPart: message
    }]
  });
  request.then(result => {
    console.log(`User Comment sent to: ${user.email} for shortName: ${system.shortName}`)
    res.json({
      success: true
    });
  })
    .catch(err => {
      console.error(err.statusCode);
      console.error(err);
      res.status(500);
      res.json({
        success: false,
        message: "Failed to send"
      });
      return;
    });


}

async function load_systems(systemClients) {
  let fromDate = new Date(Date.now() - 60 * 60 * 24 * 30 * 1000);
  const results = await System.find({ lastActive: { $gte: fromDate } }).populate('userId', "screenName").catch(err => {
    //const results = await System.find({active: true}).populate('userId', "screenName").catch( err => {
    //const results = await System.find({active: true}).catch( err => {  // super simple query
    console.error("Error - get_systems: " + err.message);
  });
  tempList = [];
  for (var result in results) {

    var clientCount = 0;
    if (systemClients && systemClients.hasOwnProperty(results[result].shortName)) {
      clientCount = systemClients[results[result].shortName];
    }
    var system = {
      name: results[result].name,
      shortName: results[result].shortName,
      systemType: results[result].systemType,
      county: results[result].county,
      country: results[result].country,
      city: results[result].city,
      state: results[result].state,
      active: results[result].active,
      lastActive: results[result].lastActive,
      callAvg: results[result].callAvg,
      description: results[result].description,
      status: results[result].status,
      allowContact: results[result].allowContact,
      clientCount: clientCount
    }
    /*
    if (results[result].showScreenName && results[result].userId) {
      system.screenName = results[result].userId.screenName
    } else {
      system.screenName = null;
    }*/
    system.screenName = null;
    tempList.push(system);
  }
  // don't update the systemList until we have all the data or else load_systems will be called multiple times
  systemList = tempList;
  // console.log("Loaded Systems: " + systemList.length + " that have been active since: " + fromDate);
}


exports.get_systems = async function (req, res) {
  /* going to use a cron job to update the system list every 2 minutes
  if ((systemList.length == 0) || (systemListTime < (Date.now() - 60 * 1000 * 2))) {
    console.log("Loading Systems - systemTime: " + systemListTime + " compare to: " + (Date.now() - 60 * 1000 * 2));
    systemListTime = Date.now(); // set this first to prevent multiple calls to load_systems
    await load_systems(req.systemClients);
  }*/

  const systemClients = req.systemClients || {};
  for (var i = 0; i < systemList.length; i++) {
    var system = systemList[i];
    var shortName = system.shortName;
    if (systemClients.hasOwnProperty(shortName)) {
      system.clientCount = systemClients[shortName];
    }
  }
  res.contentType('json');
  res.send(JSON.stringify({
    success: true,
    systems: systemList
  }));
}

exports.authorize_system = async function (req, res) {

  var shortName = req.params.shortName.toLowerCase();
  var apiKey = req.body.api_key;
  let item = null;

  try {
    item = await System.findOne({ 'shortName': shortName }, ["key"]);
  } catch (err) {
    console.warn("[" + req.params.shortName + "] Error /:shortName/authorize - Error: " + err);
    res.status(500);
    res.send("Invalid System Name\n");
    return;
  }

  if (!item) {
    console.info("[" + req.params.shortName + "] Error /:shortName/authorize ShortName does not exist");
    res.status(500);
    res.send("Invalid System Name\n");
    return;
  }

  // The submitted key used to be logged here. Logs go to syslog and are kept,
  // so that turned every mistyped config into a durable record of a credential.
  // That a mismatch happened is the useful part; the value never was.
  if (!keysMatch(apiKey, item.key)) {
    console.warn("[" + req.params.shortName + "] Error /:shortName/authorize API Key Mismatch");
    res.status(403);
    res.send("Invalid API Key\n");
    return;
  } else {
    // System shortName exists and the API Key is valid.
    res.status(200).end();
  }

}

load_systems();

var statSched = schedule.scheduleJob('*/5 * * * *', function() {
  load_systems();
});

