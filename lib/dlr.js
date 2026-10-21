// Callbacks from Africa's Talking: delivery reports, incoming messages and bulk SMS opt-outs.
//
// The send response only tells you Africa's Talking accepted a message ("Sent" means handed to the
// network). Whether it reached the phone arrives later as a delivery report posted to your callback URL.
// Field names are in the README, with which ones I could confirm. Callbacks are read as form encoded,
// and JSON is accepted too in case a callback arrives that way.

import { normalisePhone } from "./phone.js";
import { parseOptOut } from "./optout.js";

// Delivery report statuses from the Africa's Talking help centre (see README, Sources).
export const DELIVERY_STATUSES = ["Sent", "Submitted", "Buffered", "Rejected", "Success", "Failed", "Expired"];
export const FINAL_STATUSES = ["Success", "Rejected", "Failed", "Expired"];

export function parseBody(raw, contentType = "") {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
  if (/application\/json/i.test(contentType)) {
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));

export function parseDeliveryReport(fields) {
  const messageId = str(fields.id);
  const status = str(fields.status);
  if (!messageId || !status) return null;
  const retry = Number(fields.retryCount);
  return {
    messageId,
    status,
    known: DELIVERY_STATUSES.includes(status),
    final: FINAL_STATUSES.includes(status),
    phoneNumber: normalisePhone(fields.phoneNumber) || str(fields.phoneNumber),
    networkCode: str(fields.networkCode),
    failureReason: str(fields.failureReason),
    retryCount: Number.isFinite(retry) && fields.retryCount !== undefined && fields.retryCount !== "" ? retry : null,
  };
}

// An SMS someone sent to your short code. Returns the opt-out decision with it.
export function parseIncoming(fields) {
  const from = str(fields.from);
  if (!from) return null;
  const text = str(fields.text) ?? "";
  return {
    id: str(fields.id),
    from: normalisePhone(from) || from,
    to: str(fields.to),
    text,
    date: str(fields.date),
    linkId: str(fields.linkId),
    networkCode: str(fields.networkCode),
    ...parseOptOut(text),
  };
}

// Africa's Talking can tell you when a number opts out of your alphanumeric sender ID (the person
// blocked you through their network, they did not reply to you). The field name for the number is not
// confirmed (see README), so the common names are tried in order.
export function parseBulkOptOut(fields) {
  const raw = str(fields.phoneNumber) ?? str(fields.phone) ?? str(fields.number) ?? str(fields.from);
  const phone = normalisePhone(raw);
  if (!phone) return null;
  return { phone, senderId: str(fields.senderId) };
}

// The last known status per message id. A final status (Success, Failed, Rejected, Expired) is not
// replaced by a late in-between one such as Buffered, because callbacks can arrive out of order.
export function createStatusStore(kv) {
  return {
    async record(report) {
      let changed = false;
      await kv.update(report.messageId, (current) => {
        if (current && FINAL_STATUSES.includes(current.status) && !report.final) return undefined;
        changed = true;
        const { known, final, ...rest } = report;
        return { ...rest, updatedAt: new Date().toISOString() };
      });
      return { changed };
    },
    get: (messageId) => kv.get(messageId),
    async all() { return (await kv.entries()).map(([messageId, v]) => ({ ...v, messageId })); },
  };
}
