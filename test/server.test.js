import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.js";
import { createStatusStore } from "../lib/dlr.js";
import { createMemoryStore } from "../lib/store.js";
import { createMemoryOptOutStore } from "../lib/optout.js";

const TOKEN = "test_token_0123456789abcdef";
let server, base, statuses, optOuts, logs, hooks;

beforeEach(async () => {
  statuses = createStatusStore(createMemoryStore());
  optOuts = createMemoryOptOutStore();
  logs = [];
  hooks = [];
  server = createApp({ token: TOKEN, statuses, optOuts, log: (m) => logs.push(m),
    onDelivery: async (r) => hooks.push(["delivery", r.messageId]),
    onIncoming: async (m) => hooks.push(["incoming", m.from]),
    onOptOut: async (p, info) => hooks.push(["optout", p, info.source]) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => new Promise((r) => server.close(r)));

const form = (path, fields, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
const tick = () => new Promise((r) => setImmediate(r));

test("GET /health answers ok", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("a delivery report is stored, answered 200, and the hook runs after", async () => {
  const res = await form(`/sms/delivery/${TOKEN}`, { id: "ATXid_1", status: "Success", phoneNumber: "+254700000101", networkCode: "63902", retryCount: "0" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const saved = await statuses.get("ATXid_1");
  assert.equal(saved.status, "Success");
  assert.equal(saved.networkCode, "63902");
  await tick(); await tick();
  assert.deepEqual(hooks, [["delivery", "ATXid_1"]]);
});

test("the token can come as a header instead of in the path", async () => {
  const res = await form("/sms/delivery", { id: "ATXid_2", status: "Failed" }, { "x-callback-token": TOKEN });
  assert.equal(res.status, 200);
  assert.equal((await statuses.get("ATXid_2")).status, "Failed");
});

test("a wrong or missing token is refused and nothing is stored", async () => {
  for (const path of ["/sms/delivery/wrong_token_0123456789", "/sms/delivery", `/sms/delivery/${TOKEN}x`]) {
    const res = await form(path, { id: "ATXid_3", status: "Success" });
    assert.equal(res.status, 403, path);
  }
  assert.equal(await statuses.get("ATXid_3"), null);
});

test("an incoming STOP opts the sender out; other messages do not", async () => {
  assert.equal((await form(`/sms/incoming/${TOKEN}`, { from: "+254700000101", to: "40404", text: "Stop", id: "1", date: "2026-10-21" })).status, 200);
  assert.equal((await form(`/sms/incoming/${TOKEN}`, { from: "+254700000102", to: "40404", text: "Asante sana", id: "2" })).status, 200);
  assert.equal(await optOuts.has("0700000101"), true);
  assert.equal(await optOuts.has("0700000102"), false);
  await tick(); await tick();
  assert.deepEqual(hooks.filter((h) => h[0] === "optout"), [["optout", "+254700000101", "reply"]]);
  assert.equal(hooks.filter((h) => h[0] === "incoming").length, 2);
});

test("a bulk opt-out notification adds the number", async () => {
  assert.equal((await form(`/sms/optout/${TOKEN}`, { phoneNumber: "+254700000103", senderId: "EpicPrime" })).status, 200);
  const [row] = await optOuts.list();
  assert.equal(row.phone, "+254700000103");
  assert.equal(row.source, "bulk-optout");
});

test("JSON callbacks are accepted too", async () => {
  const res = await fetch(`${base}/sms/delivery/${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "ATXid_4", status: "Rejected" }) });
  assert.equal(res.status, 200);
  assert.equal((await statuses.get("ATXid_4")).status, "Rejected");
});

test("junk with a valid token still gets 200, so Africa's Talking stops retrying", async () => {
  assert.equal((await form(`/sms/delivery/${TOKEN}`, { hello: "world" })).status, 200);
  assert.equal((await form(`/sms/optout/${TOKEN}`, { phoneNumber: "12" })).status, 200);
  assert.ok(logs.some((l) => /ignored/.test(l)));
});

test("bodies over 16 KB are refused", async () => {
  const res = await fetch(`${base}/sms/delivery/${TOKEN}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "id=x&status=Success&pad=" + "a".repeat(17 * 1024) });
  assert.equal(res.status, 413);
  assert.equal(await statuses.get("x"), null);
});

test("unknown routes are 404 and wrong methods are 405", async () => {
  assert.equal((await fetch(`${base}/sms/other/${TOKEN}`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/sms/delivery/${TOKEN}`)).status, 405);
  assert.equal((await fetch(`${base}/health`, { method: "POST" })).status, 405);
});

test("a hook that throws does not break the answer", async () => {
  const s2 = createApp({ token: TOKEN, log: (m) => logs.push(m), onDelivery: async () => { throw new Error("boom"); } });
  await new Promise((r) => s2.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${s2.address().port}/sms/delivery/${TOKEN}`, { method: "POST", body: "id=a&status=Success", headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(res.status, 200);
    await tick(); await tick();
    assert.ok(logs.some((l) => /hook failed: boom/.test(l)));
  } finally {
    await new Promise((r) => s2.close(r));
  }
});

test("the server will not start without a long enough token", () => {
  assert.throws(() => createApp({ token: "" }), /CALLBACK_TOKEN/);
  assert.throws(() => createApp({ token: "short" }), /at least 16/);
});
