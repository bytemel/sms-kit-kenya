import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBody, parseDeliveryReport, parseIncoming, parseBulkOptOut, createStatusStore, DELIVERY_STATUSES } from "../lib/dlr.js";
import { createMemoryStore } from "../lib/store.js";

test("bodies: form encoded by default, JSON when the content type says so, junk becomes empty", () => {
  assert.deepEqual(parseBody("id=ATXid_1&status=Success&phoneNumber=%2B254700000101", "application/x-www-form-urlencoded"), { id: "ATXid_1", status: "Success", phoneNumber: "+254700000101" });
  assert.deepEqual(parseBody(Buffer.from('{"id":"x","status":"Failed"}'), "application/json; charset=utf-8"), { id: "x", status: "Failed" });
  assert.deepEqual(parseBody("{not json", "application/json"), {});
  assert.deepEqual(parseBody("[1,2]", "application/json"), {});
});

test("delivery reports keep every documented field", () => {
  const r = parseDeliveryReport({ id: "ATXid_1", status: "Failed", phoneNumber: "+254700000101", networkCode: "63902", failureReason: "UserInBlacklist", retryCount: "0" });
  assert.deepEqual(r, { messageId: "ATXid_1", status: "Failed", known: true, final: true, phoneNumber: "+254700000101", networkCode: "63902", failureReason: "UserInBlacklist", retryCount: 0 });
  assert.equal(parseDeliveryReport({ id: "x", status: "Buffered" }).final, false);
  assert.equal(parseDeliveryReport({ id: "x", status: "Delivered?" }).known, false);
  assert.equal(parseDeliveryReport({ status: "Success" }), null);
  assert.equal(parseDeliveryReport({ id: "x" }), null);
  assert.deepEqual(DELIVERY_STATUSES, ["Sent", "Submitted", "Buffered", "Rejected", "Success", "Failed", "Expired"]);
});

test("incoming messages are parsed and STOP is spotted", () => {
  const m = parseIncoming({ from: "+254700000101", to: "40404", text: " stop ", date: "2026-10-21 10:00:00", id: "abc", linkId: "L1" });
  assert.equal(m.from, "+254700000101");
  assert.equal(m.optOut, true);
  assert.equal(m.keyword, "STOP");
  assert.equal(parseIncoming({ from: "+254700000101", text: "Asante" }).optOut, false);
  assert.equal(parseIncoming({ text: "STOP" }), null);
});

test("bulk opt-out notifications give a normalised number", () => {
  assert.deepEqual(parseBulkOptOut({ phoneNumber: "254700000101", senderId: "EpicPrime" }), { phone: "+254700000101", senderId: "EpicPrime" });
  assert.equal(parseBulkOptOut({ phoneNumber: "nope" }), null);
});

test("status store keeps the last status, and a late in-between status does not undo a final one", async () => {
  const s = createStatusStore(createMemoryStore());
  await s.record(parseDeliveryReport({ id: "m1", status: "Sent" }));
  await s.record(parseDeliveryReport({ id: "m1", status: "Buffered" }));
  assert.equal((await s.get("m1")).status, "Buffered");
  await s.record(parseDeliveryReport({ id: "m1", status: "Success" }));
  const late = await s.record(parseDeliveryReport({ id: "m1", status: "Buffered" }));
  assert.equal(late.changed, false);
  assert.equal((await s.get("m1")).status, "Success");
  await s.record(parseDeliveryReport({ id: "m1", status: "Failed", failureReason: "DeliveryFailure" }));
  assert.equal((await s.get("m1")).status, "Failed");
  assert.deepEqual((await s.all()).map((r) => r.messageId), ["m1"]);
});
