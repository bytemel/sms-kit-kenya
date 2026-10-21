// Callback server for Africa's Talking SMS on plain node:http. No dependencies.
// Run: node --env-file=.env server.js   (needs CALLBACK_TOKEN; see .env.example)
//
//   GET  /health                   { ok: true }
//   POST /sms/delivery/<token>     delivery reports: the last status per message id is stored
//   POST /sms/incoming/<token>     messages sent to your short code: STOP style replies opt the sender out
//   POST /sms/optout/<token>       bulk SMS opt-outs from your alphanumeric sender ID
//
// Africa's Talking does not sign its callbacks as far as I could confirm, so anyone who knows the URL
// could post a fake report. The token in the path is the guard: a long random string only you and the
// Africa's Talking dashboard know. A proxy can send it as an x-callback-token header instead.

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseBody, parseDeliveryReport, parseIncoming, parseBulkOptOut, createStatusStore } from "./lib/dlr.js";
import { createMemoryStore, createJsonFileStore } from "./lib/store.js";
import { createMemoryOptOutStore, createJsonFileOptOutStore } from "./lib/optout.js";

const BODY_LIMIT = 16 * 1024; // callbacks are a handful of short fields
const ROUTES = new Set(["delivery", "incoming", "optout"]);

// Logs show only the last 4 digits of a phone number: enough to find the person, not to text them.
export const maskPhone = (phone) => `...${String(phone ?? "").slice(-4)}`;

const digest = (s) => createHash("sha256").update(String(s)).digest();
const sameToken = (given, expected) => typeof given === "string" && timingSafeEqual(digest(given), digest(expected));

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("Body too large"), { status: 413 })); req.resume(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createApp({
  token = process.env.CALLBACK_TOKEN,
  statuses = createStatusStore(createMemoryStore()),
  optOuts = createMemoryOptOutStore(),
  onDelivery = async () => {}, // runs after the 200 is sent: update your outbox, alert on Failed
  onIncoming = async () => {}, // every incoming message, opt-out or not
  onOptOut = async () => {},   // a number was added to the opt-out list
  log = (...a) => console.log(...a),
} = {}) {
  if (!token || String(token).length < 16) throw new Error("Set CALLBACK_TOKEN to a random string of at least 16 characters, for example: openssl rand -hex 24");

  const later = (fn) => setImmediate(() => Promise.resolve().then(fn).catch((err) => log(`callback hook failed: ${err.message}`)));

  async function handle(route, fields) {
    if (route === "delivery") {
      const report = parseDeliveryReport(fields);
      if (!report) return log("delivery report ignored: no id or status");
      if (!report.known) log(`delivery report with an unexpected status "${report.status}" for ${report.messageId}`);
      await statuses.record(report);
      later(() => onDelivery(report));
    } else if (route === "incoming") {
      const msg = parseIncoming(fields);
      if (!msg) return log("incoming message ignored: no sender");
      if (msg.optOut) {
        const phone = await optOuts.add(msg.from, { source: "reply", text: msg.text.slice(0, 40) }).catch(() => null);
        if (phone) { log(`opt-out from ${maskPhone(phone)} ("${msg.keyword}")`); later(() => onOptOut(phone, { source: "reply" })); }
      }
      later(() => onIncoming(msg));
    } else {
      const out = parseBulkOptOut(fields);
      if (!out) return log("opt-out notification ignored: no valid phone number");
      await optOuts.add(out.phone, { source: "bulk-optout", senderId: out.senderId });
      log(`opt-out from ${maskPhone(out.phone)} (network block)`);
      later(() => onOptOut(out.phone, { source: "bulk-optout", senderId: out.senderId }));
    }
  }

  return createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://local");
      if (pathname === "/health") return req.method === "GET" ? reply(res, 200, { ok: true }) : reply(res, 405, { ok: false });

      const m = pathname.match(/^\/sms\/([a-z]+)(?:\/([^/]+))?\/?$/);
      if (!m || !ROUTES.has(m[1])) return reply(res, 404, { ok: false });
      if (req.method !== "POST") return reply(res, 405, { ok: false });
      const given = m[2] ?? req.headers["x-callback-token"];
      if (!sameToken(given, token)) { req.resume(); return reply(res, 403, { ok: false }); }

      const raw = await readBody(req, BODY_LIMIT);
      await handle(m[1], parseBody(raw, req.headers["content-type"]));
      // Always 200 for a well formed request, even when the content is ignored, so Africa's Talking
      // stops retrying. It retries an unanswered callback for hours.
      return reply(res, 200, { ok: true });
    } catch (err) {
      if (err.status === 413) return reply(res, 413, { ok: false });
      log(`callback error: ${err.message}`);
      return reply(res, 500, { ok: false });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = process.env.DATA_DIR || "data";
  try {
    const app = createApp({
      statuses: createStatusStore(createJsonFileStore(join(dataDir, "statuses.json"))),
      optOuts: createJsonFileOptOutStore(join(dataDir, "optouts.json")),
    });
    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => console.log(`SMS callbacks listening on http://localhost:${port} (data in ${dataDir}/)`));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
