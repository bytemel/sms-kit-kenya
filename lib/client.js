// Bulk SMS through Africa's Talking, with the checks that keep a send cheap and single.
//
// Order of work for every send:
//   1. merge the template per person, swap curly quotes and long dashes so the text stays GSM-7
//   2. skip bad numbers, missing fields, duplicates and people who opted out, with a reason each
//   3. skip anyone this campaign already reached (the ledger), and flag anyone whose last attempt
//      has an unknown outcome instead of sending again
//   4. dry run stops here and returns the plan. A real send claims each message in the ledger,
//      posts the batch, and records each person as sent or failed.
//
// Africa's Talking charges once it accepts a message, so the one thing this file will not do is send
// again when it cannot tell whether the first attempt went through.

import { createHash } from "node:crypto";
import { parsePhone, normalisePhone } from "./phone.js";
import { mergeAll } from "./template.js";
import { toGsmSafe, estimateCost } from "./segments.js";
import { createMemoryStore } from "./store.js";
import { createMemoryOptOutStore } from "./optout.js";

export const BASE_URLS = {
  live: "https://api.africastalking.com/version1/messaging",
  sandbox: "https://api.sandbox.africastalking.com/version1/messaging",
};
// statusCode values in the send response that mean "accepted": 100 Processed, 101 Sent, 102 Queued.
export const ACCEPTED_CODES = [100, 101, 102];
export const BLACKLIST_CODE = 406;
// I could not find a documented maximum number of recipients per request. 100 is a cautious default.
export const DEFAULT_BATCH_SIZE = 100;
// Connection errors where the request never reached Africa's Talking, so trying again is safe.
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
// HTTP answers retried by default. 503 means "not available, try later", so the message was not taken.
// Any other 5xx may come after Africa's Talking accepted the message, so it is never retried.
export const RETRY_STATUSES = [503];

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const templateHash = (template) => sha256(String(template));

// Same person, same campaign, same template: same key. A retry finds the key and does not resend.
export const idempotencyKey = ({ phone, campaign, template }) =>
  sha256(`${normalisePhone(phone) || phone}\n${campaign}\n${templateHash(template)}`);

// Ledger statuses: "pending" (claimed, outcome not known yet), "sent" (accepted), "failed" (refused,
// so a later run may try again).
export function createLedger(kv = createMemoryStore()) {
  return {
    get: (key) => kv.get(key),
    async claim(key, info) {
      let claimed = false;
      let previous = null;
      await kv.update(key, (current) => {
        previous = current;
        if (current && current.status !== "failed") return undefined;
        claimed = true;
        return { ...info, status: "pending", attempts: (current?.attempts || 0) + 1, claimedAt: new Date().toISOString() };
      });
      return { claimed, previous };
    },
    settle: (key, patch) => kv.update(key, (current) => ({ ...(current || {}), ...patch, settledAt: new Date().toISOString() })),
    // Settle a "pending" entry by hand after checking the dashboard. "sent" keeps it skipped for good,
    // "failed" lets the next run send it. Returns the entry, or null when the key was not pending.
    async resolve(key, status, extra = {}) {
      if (!["sent", "failed"].includes(status)) throw new Error('Resolve a pending send as "sent" or "failed".');
      return kv.update(key, (current) => current?.status === "pending"
        ? { ...current, ...extra, status, resolvedByHand: true, settledAt: new Date().toISOString() }
        : undefined);
    },
    async all() { return (await kv.entries()).map(([key, v]) => ({ key, ...v })); },
  };
}

// Turn one response into sent and failed per phone. Numbers missing from the response are unknown.
export function parseSendResponse(data, phones) {
  const rows = data?.SMSMessageData?.Recipients;
  const byPhone = new Map();
  for (const r of Array.isArray(rows) ? rows : []) byPhone.set(normalisePhone(r.number) || r.number, r);
  const sent = [];
  const failed = [];
  const unknown = [];
  for (const phone of phones) {
    const r = byPhone.get(phone);
    if (!r) { unknown.push({ phone, reason: `Not in the response. ${data?.SMSMessageData?.Message || ""}`.trim() }); continue; }
    const statusCode = Number(r.statusCode);
    const base = { phone, status: r.status, statusCode, messageId: r.messageId && r.messageId !== "None" ? r.messageId : null, cost: r.cost ?? null, messageParts: r.messageParts ?? null };
    if (ACCEPTED_CODES.includes(statusCode)) sent.push(base);
    else failed.push({ ...base, reason: r.status || `statusCode ${r.statusCode}` });
  }
  return { sent, failed, unknown };
}

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

export function createSmsClient({
  mode = "sandbox",
  username = mode === "sandbox" ? "sandbox" : undefined,
  apiKey,
  senderId,
  fetch = globalThis.fetch,
  ledger = createLedger(),
  optOuts = createMemoryOptOutStore(),
  batchSize = DEFAULT_BATCH_SIZE,
  timeoutMs = 15000,
  retries = 2,
  retryStatuses = RETRY_STATUSES,
  backoffMs = 500,
  rate,
  gsmSafe = true,
  enqueue = false,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!BASE_URLS[mode]) throw new Error(`mode must be "sandbox" or "live", not "${mode}".`);
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a whole number of 1 or more.");
  const url = BASE_URLS[mode];

  function checkReady() {
    if (!apiKey) throw new Error("No Africa's Talking API key. Set AT_API_KEY.");
    if (!username) throw new Error("No Africa's Talking username. Set AT_USERNAME.");
    if (mode === "live" && username === "sandbox") throw new Error('The live API needs your app username, not "sandbox".');
    if (mode === "sandbox" && username !== "sandbox") throw new Error('The sandbox username is always "sandbox".');
  }

  async function post(phones, message) {
    const body = new URLSearchParams({ username, to: phones.join(","), message, bulkSMSMode: "1" });
    if (senderId) body.set("from", senderId);
    if (enqueue) body.set("enqueue", "1");
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      let text;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { apiKey, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: controller.signal,
        });
        text = await res.text();
      } catch (err) {
        if (controller.signal.aborted) return { kind: "unknown", reason: `No answer within ${timeoutMs / 1000} seconds. The message may have gone out.` };
        const code = err?.cause?.code || err?.code;
        if (NEVER_SENT.has(code)) {
          if (attempt < retries) { await sleep(backoffMs * 2 ** attempt); continue; }
          return { kind: "notSent", reason: `Could not reach Africa's Talking (${code}).` };
        }
        return { kind: "unknown", reason: `The connection broke (${code || err.message}). The message may have gone out.` };
      } finally {
        clearTimeout(timer);
      }
      if (retryStatuses.includes(res.status) && attempt < retries) { await sleep(backoffMs * 2 ** attempt); continue; }
      if (res.status >= 500) {
        return { kind: "unknown", reason: `Africa's Talking answered ${res.status}${attempt ? ` ${attempt + 1} times` : ""}. The message may have gone out.` };
      }
      if (!res.ok) return { kind: "notSent", reason: `Africa's Talking refused the request (${res.status}): ${text.slice(0, 200).trim()}` };
      try {
        return { kind: "ok", data: JSON.parse(text) };
      } catch {
        return { kind: "unknown", reason: "Africa's Talking answered with something that is not JSON." };
      }
    }
  }

  async function plan({ campaign, template, recipients, phoneField }) {
    const merged = mergeAll(template, recipients, { transform: gsmSafe ? toGsmSafe : (t) => t });
    const messages = [];
    const skipped = [];
    const needsChecking = [];
    const seen = new Set();
    for (const row of merged) {
      const phone = parsePhone(row.person[phoneField]);
      const skip = (reason) => skipped.push({ index: row.index, phone: phone.e164 || row.person[phoneField] || null, reason });
      if (!phone.ok) { skip(phone.reason); continue; }
      if (row.missing.length) { skip(`Missing ${row.missing.join(", ")}.`); continue; }
      if (!row.text.trim()) { skip("The message is empty."); continue; }
      if (seen.has(phone.e164)) { skip("Listed more than once. Sent once."); continue; }
      seen.add(phone.e164);
      if (await optOuts.has(phone.e164)) { skip("Opted out."); continue; }
      const key = idempotencyKey({ phone: phone.e164, campaign, template });
      const before = await ledger.get(key);
      if (before?.status === "sent") { skip("Already sent in this campaign."); continue; }
      if (before?.status === "pending") {
        needsChecking.push({ index: row.index, phone: phone.e164, key, reason: "An earlier attempt may have gone out. Check the Africa's Talking dashboard before sending again." });
        continue;
      }
      messages.push({ index: row.index, phone: phone.e164, text: row.text, encoding: row.encoding, length: row.length, segments: row.segments, warnings: row.warnings, key });
    }
    const segments = messages.reduce((n, m) => n + m.segments, 0);
    const totals = { recipients: messages.length, segments, rate: rate ?? null, estimatedCost: estimateCost({ segments, recipients: 1, rate }) };
    return { messages, skipped, needsChecking, totals };
  }

  async function send({ campaign, template, message, recipients, phoneField = "phone", dryRun = false } = {}) {
    template = template ?? message;
    if (!campaign || !String(campaign).trim()) throw new Error('Give every send a campaign key, such as "class-reminder-2026-10-21". It is how a retry knows what already went out.');
    if (!template || !String(template).trim()) throw new Error("No message or template given.");
    if (!Array.isArray(recipients)) throw new Error("recipients must be a list.");

    const p = await plan({ campaign: String(campaign), template: String(template), recipients, phoneField });
    if (dryRun) return { dryRun: true, mode, ...p };
    checkReady();

    const sent = [];
    const failed = [];
    const skipped = [...p.skipped];
    const needsChecking = [...p.needsChecking];

    const byText = new Map();
    for (const m of p.messages) byText.set(m.text, [...(byText.get(m.text) || []), m]);

    for (const [text, group] of byText) {
      for (const batch of chunk(group, batchSize)) {
        const mine = [];
        for (const m of batch) {
          const { claimed } = await ledger.claim(m.key, { phone: m.phone, campaign, segments: m.segments });
          if (claimed) mine.push(m);
          else skipped.push({ index: m.index, phone: m.phone, reason: "Another run is sending or has sent this message." });
        }
        if (!mine.length) continue;
        const byPhone = new Map(mine.map((m) => [m.phone, m]));
        const result = await post(mine.map((m) => m.phone), text);

        if (result.kind === "ok") {
          const parsed = parseSendResponse(result.data, [...byPhone.keys()]);
          for (const s of parsed.sent) {
            await ledger.settle(byPhone.get(s.phone).key, { status: "sent", messageId: s.messageId, cost: s.cost });
            sent.push({ index: byPhone.get(s.phone).index, ...s });
          }
          for (const f of parsed.failed) {
            await ledger.settle(byPhone.get(f.phone).key, { status: "failed", reason: f.reason, statusCode: f.statusCode });
            if (f.statusCode === BLACKLIST_CODE || f.status === "UserInBlacklist") await optOuts.add(f.phone, { source: "UserInBlacklist" });
            failed.push({ index: byPhone.get(f.phone).index, ...f });
          }
          for (const u of parsed.unknown) needsChecking.push({ index: byPhone.get(u.phone).index, key: byPhone.get(u.phone).key, ...u });
        } else if (result.kind === "notSent") {
          for (const m of mine) {
            await ledger.settle(m.key, { status: "failed", reason: result.reason });
            failed.push({ index: m.index, phone: m.phone, reason: result.reason });
          }
        } else {
          for (const m of mine) needsChecking.push({ index: m.index, phone: m.phone, key: m.key, reason: result.reason });
        }
      }
    }
    return { dryRun: false, mode, sent, failed, skipped, needsChecking, totals: p.totals };
  }

  return { send, mode, url };
}
