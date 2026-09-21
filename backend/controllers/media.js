/**
 * Signed playback URLs.
 *
 * Call audio used to be written world-readable and its URL stored on the Call
 * document, which meant gating the API achieved nothing: the object keys are
 * predictable (media/{shortName}/{talkgroup}/{shortName}-{talkgroup}-{start}.m4a)
 * and anyone holding a URL could listen without an account.
 *
 * Objects are now private. package_call hands the player a URL pointing back
 * here instead of at the bucket, and this redirects to a short-lived presigned
 * URL once the listener has been checked. The player needs no changes - it
 * still just plays call.url.
 */
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const path = require("path");
const { ObjectId } = require("mongodb");

const Call = require("../models/call");
// Settings and client both come from config/s3.js, the only place this service
// reads the S3_* variables. This file used to keep its own copy, defaulting to
// upstream openmhz's Wasabi bucket whenever they were unset.
//
// Reads from the store over the internal address - this is a server-side fetch,
// so it never needs the browser-reachable one.
const { s3Client, bucket: s3_bucket } = require("../config/s3");

/**
 * The URL handed to the player for a call. Points at this service, not the
 * bucket, so the listener check happens on every playback.
 */
const backend_server = process.env['REACT_APP_BACKEND_SERVER'] != null ? process.env['REACT_APP_BACKEND_SERVER'] : 'https://api.hamrecorder.com';

exports.playbackUrl = function (shortName, callId) {
  return `${backend_server}/${shortName}/call/${callId}/media`;
};

exports.get_media = async function (req, res) {
  let o_id;
  try {
    o_id = ObjectId.createFromHexString(req.params.id);
  } catch (err) {
    res.status(400);
    res.contentType('json');
    res.send(JSON.stringify({ success: false, message: "Invalid call id" }));
    return;
  }

  let item;
  try {
    item = await Call.findById(o_id).exec();
  } catch (err) {
    console.error(`[${req.params.shortName}] Error /media looking up call: ${err}`);
    res.status(500);
    res.contentType('json');
    res.send(JSON.stringify({ success: false, message: "Could not look up call" }));
    return;
  }

  if (!item) {
    res.status(404);
    res.contentType('json');
    res.send(JSON.stringify({ success: false, message: "Call not found" }));
    return;
  }

  // Calls carry the bucket they were written to, so recordings made before a
  // bucket change still resolve.
  const bucket = item.bucket || s3_bucket;
  const key = item.objectKey;

  if (!key) {
    console.warn(`[${item.shortName}] Call ${req.params.id} has no objectKey`);
    res.status(404);
    res.contentType('json');
    res.send(JSON.stringify({ success: false, message: "Call has no stored audio" }));
    return;
  }

  // Streamed rather than redirected to a presigned URL. A redirect looks
  // tidier, but the player fetches this with credentials, and on a cross-origin
  // redirect the browser retries with "Origin: null" - to which the object
  // store answers "Access-Control-Allow-Origin: *", which browsers reject
  // outright on a credentialed request. The audio never loads. Serving the
  // bytes from this origin keeps it to one hop with CORS that already works.
  let out;
  try {
    out = await s3Client().send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      // Forwarded so seeking works - media elements ask for byte ranges.
      ...(req.headers.range ? { Range: req.headers.range } : {}),
    }));
  } catch (err) {
    const status = err.$metadata && err.$metadata.httpStatusCode;
    if (status === 404 || err.name === 'NoSuchKey') {
      console.warn(`[${item.shortName}] Audio missing from the bucket: ${key}`);
      res.status(404);
      res.contentType('json');
      res.send(JSON.stringify({ success: false, message: "Audio not found" }));
      return;
    }
    console.error(`[${item.shortName}] Error reading audio ${key}: ${err}`);
    res.status(500);
    res.contentType('json');
    res.send(JSON.stringify({ success: false, message: "Could not read audio" }));
    return;
  }

  // Objects were uploaded without a content type, so the store reports
  // application/octet-stream. Name it properly here from the extension.
  const ext = path.extname(key).toLowerCase();
  res.set('Content-Type', ext === '.mp3' ? 'audio/mpeg' : 'audio/mp4');
  res.set('Accept-Ranges', 'bytes');
  // Private: this is per-listener content behind a session, so it must not be
  // held by any shared cache.
  res.set('Cache-Control', 'private, max-age=300');
  if (out.ContentLength != null) {
    res.set('Content-Length', String(out.ContentLength));
  }
  if (out.ContentRange) {
    res.set('Content-Range', out.ContentRange);
  }
  res.status(out.ContentRange ? 206 : 200);

  out.Body.on('error', (err) => {
    console.error(`[${item.shortName}] Error streaming audio ${key}: ${err}`);
    res.destroy();
  });
  out.Body.pipe(res);
};
