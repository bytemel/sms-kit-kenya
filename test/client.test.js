import { test } from "node:test";
import assert from "node:assert/strict";
import { createSmsClient, createLedger, idempotencyKey, parseSendResponse, BASE_URLS } from "../lib/client.js";
import { createMemoryOptOutStore } from "../lib/optout.js";

const KEY = "atsk_test_key_for_tests_only";
const PEOPLE = [
  { first_name: "Akinyi", phone: "0700 000 101" },
  { first_name: "Baraka", phone: "+254700000102" },
];
const TEMPLATE = "Hi {{first_name}}, class is on Saturday at 10am.";

// A fake Africa's Talking. It records every call and never touches the network.
function fakeAT(handler = () => null) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url, init, body });
    const custom = await handler(body, calls.length, init);
    if (custom) return custom;
    const Recipients = body.to.split(",").map((number) => ({ statusCode: 101, number, status: "Success", cost: "KES 0.8000", messageId: `ATXid_${++n}` }));
    return new Response(JSON.stringify({ SMSMessageData: { Message: `Sent to ${Recipients.length}/${Recipients.length}`, Recipients } }), { status: 201 });
  };
  return { fetch, calls };
}

const client = (fetch, extra = {}) => createSmsClient({ apiKey: KEY, fetch, sleep: async () => {}, ...extra });

test("dry run returns the exact plan and makes no network call", async () => {
  const at = fakeAT();
  const out = await client(at.fetch, { rate: "0.8" }).send({ campaign: "c1", template: "Hi {{first_name}}, don\u2019t be late.", recipients: [...PEOPLE, { first_name: "X", phone: "12" }], dryRun: true });
  assert.equal(at.calls.length, 0);
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.messages.map((m) => [m.phone, m.text, m.encoding, m.segments]), [
    ["+254700000101", "Hi Akinyi, don't be late.", "GSM-7", 1],
    ["+254700000102", "Hi Baraka, don't be late.", "GSM-7", 1],
  ]);
  assert.deepEqual(out.totals, { recipients: 2, segments: 2, rate: "0.8", estimatedCost: 1.6 });
  assert.match(out.skipped[0].reason, /Too short/);
});

test("dry run works with no API key, and a real send refuses without one", async () => {
  const sms = createSmsClient({ fetch: fakeAT().fetch });
  assert.equal((await sms.send({ campaign: "c", template: "Hi", recipients: PEOPLE, dryRun: true })).messages.length, 2);
  await assert.rejects(sms.send({ campaign: "c", template: "Hi", recipients: PEOPLE }), /AT_API_KEY/);
});

test("the request matches the Africa's Talking bulk SMS API", async () => {
  const at = fakeAT();
  const out = await client(at.fetch, { senderId: "EpicPrime", enqueue: true }).send({ campaign: "c1", template: "Class is at 10am.", recipients: PEOPLE });
  assert.equal(at.calls.length, 1);
  const [{ url, init, body }] = at.calls;
  assert.equal(url, BASE_URLS.sandbox);
  assert.equal(url, "https://api.sandbox.africastalking.com/version1/messaging");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.apiKey, KEY);
  assert.equal(init.headers.Accept, "application/json");
  assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(body, { username: "sandbox", to: "+254700000101,+254700000102", message: "Class is at 10am.", bulkSMSMode: "1", from: "EpicPrime", enqueue: "1" });
  assert.deepEqual(out.sent.map((s) => [s.phone, s.messageId, s.statusCode]), [["+254700000101", "ATXid_1", 101], ["+254700000102", "ATXid_2", 101]]);
  assert.equal(BASE_URLS.live, "https://api.africastalking.com/version1/messaging");
});

test("the same send twice sends once", async () => {
  const at = fakeAT();
  const sms = client(at.fetch);
  const first = await sms.send({ campaign: "oct-reminder", template: TEMPLATE, recipients: PEOPLE });
  const second = await sms.send({ campaign: "oct-reminder", template: TEMPLATE, recipients: PEOPLE });
  assert.equal(at.calls.length, 2); // one per person, because each text is personal
  assert.equal(first.sent.length, 2);
  assert.equal(second.sent.length, 0);
  assert.deepEqual(second.skipped.map((s) => s.reason), ["Already sent in this campaign.", "Already sent in this campaign."]);
  const dry = await sms.send({ campaign: "oct-reminder", template: TEMPLATE, recipients: PEOPLE, dryRun: true });
  assert.equal(dry.messages.length, 0);
  const next = await sms.send({ campaign: "nov-reminder", template: TEMPLATE, recipients: PEOPLE });
  assert.equal(next.sent.length, 2);
});

test("two runs at the same moment still send once", async () => {
  const at = fakeAT();
  const sms = client(at.fetch);
  const [a, b] = await Promise.all([1, 2].map(() => sms.send({ campaign: "race", template: "Same text", recipients: PEOPLE })));
  assert.equal(a.sent.length + b.sent.length, 2);
  const allTo = at.calls.flatMap((c) => c.body.to.split(","));
  assert.deepEqual(allTo.sort(), ["+254700000101", "+254700000102"]);
});

test("idempotency key: same person, campaign and template match; anything else differs", () => {
  const k = idempotencyKey({ phone: "0700000101", campaign: "c", template: "t" });
  assert.equal(k, idempotencyKey({ phone: "+254 700 000 101", campaign: "c", template: "t" }));
  assert.notEqual(k, idempotencyKey({ phone: "0700000101", campaign: "c2", template: "t" }));
  assert.notEqual(k, idempotencyKey({ phone: "0700000101", campaign: "c", template: "t2" }));
  assert.match(k, /^[a-f0-9]{64}$/);
});

test("same text goes out in batches of batchSize", async () => {
  const at = fakeAT();
  const people = Array.from({ length: 5 }, (_, i) => ({ phone: `070000010${i}` }));
  const out = await client(at.fetch, { batchSize: 2 }).send({ campaign: "b", template: "Same for all", recipients: people });
  assert.deepEqual(at.calls.map((c) => c.body.to.split(",").length), [2, 2, 1]);
  assert.equal(out.sent.length, 5);
});

test("bad numbers, missing fields, duplicates and opt-outs are skipped before sending", async () => {
  const at = fakeAT();
  const optOuts = createMemoryOptOutStore();
  await optOuts.add("0700000105");
  const out = await client(at.fetch, { optOuts }).send({ campaign: "s", template: "Hi {{first_name}}", recipients: [
    { first_name: "A", phone: "0700000101" }, { first_name: "", phone: "0700000102" }, { first_name: "C", phone: "abc" },
    { first_name: "D", phone: "254700000101" }, { first_name: "E", phone: "0700000105" },
  ] });
  assert.equal(at.calls.length, 1);
  assert.deepEqual(out.skipped.map((s) => s.reason), ["Missing first_name.", "Has letters or symbols in it. Use digits only, with an optional + at the start.", "Listed more than once. Sent once.", "Opted out."]);
});

test("failed recipients get the reason, and a later run may try them again", async () => {
  const at = fakeAT((body, n) => n === 1 ? new Response(JSON.stringify({ SMSMessageData: { Message: "Sent to 0/1", Recipients: [{ statusCode: 405, number: body.to, status: "InsufficientBalance", cost: "0", messageId: "None" }] } }), { status: 201 }) : null);
  const sms = client(at.fetch);
  const one = [PEOPLE[0]];
  const first = await sms.send({ campaign: "f", template: "Hi", recipients: one });
  assert.deepEqual(first.failed.map((f) => [f.phone, f.reason, f.statusCode, f.messageId]), [["+254700000101", "InsufficientBalance", 405, null]]);
  const second = await sms.send({ campaign: "f", template: "Hi", recipients: one });
  assert.equal(second.sent.length, 1);
  assert.equal(at.calls.length, 2);
});

test("UserInBlacklist adds the number to the opt-out list", async () => {
  const optOuts = createMemoryOptOutStore();
  const at = fakeAT((body) => new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ statusCode: 406, number: body.to, status: "UserInBlacklist", cost: "0", messageId: "None" }] } }), { status: 201 }));
  const out = await client(at.fetch, { optOuts }).send({ campaign: "bl", template: "Hi", recipients: [PEOPLE[0]] });
  assert.equal(out.failed[0].reason, "UserInBlacklist");
  assert.equal(await optOuts.has("0700000101"), true);
  assert.equal((await optOuts.list())[0].source, "UserInBlacklist");
});

test("a timeout is never retried and is flagged for checking, also on the next run", async () => {
  const at = fakeAT((body, n, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
  const sms = client(at.fetch, { timeoutMs: 20 });
  const first = await sms.send({ campaign: "t", template: "Hi", recipients: [PEOPLE[0]] });
  assert.equal(at.calls.length, 1);
  assert.equal(first.sent.length + first.failed.length, 0);
  assert.match(first.needsChecking[0].reason, /may have gone out/);
  const second = await sms.send({ campaign: "t", template: "Hi", recipients: [PEOPLE[0]] });
  assert.equal(at.calls.length, 1);
  assert.match(second.needsChecking[0].reason, /Check the Africa's Talking dashboard/);
});

test("a 5xx answer is retried with backoff", async () => {
  const waits = [];
  const at = fakeAT((body, n) => n < 3 ? new Response("busy", { status: 503 }) : null);
  const out = await client(at.fetch, { sleep: async (ms) => waits.push(ms), backoffMs: 100 }).send({ campaign: "r", template: "Hi", recipients: [PEOPLE[0]] });
  assert.equal(at.calls.length, 3);
  assert.deepEqual(waits, [100, 200]);
  assert.equal(out.sent.length, 1);
});

test("5xx every time ends as needs checking, not as a blind resend", async () => {
  const at = fakeAT(() => new Response("down", { status: 500 }));
  const out = await client(at.fetch, { retries: 2 }).send({ campaign: "r5", template: "Hi", recipients: [PEOPLE[0]] });
  assert.equal(at.calls.length, 3);
  assert.match(out.needsChecking[0].reason, /answered 500 3 times/);
});

test("connection refused is retried, then failed so a later run can send", async () => {
  const refused = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
  const at = fakeAT(refused);
  const sms = client(at.fetch, { retries: 1 });
  const out = await sms.send({ campaign: "cr", template: "Hi", recipients: [PEOPLE[0]] });
  assert.equal(at.calls.length, 2);
  assert.match(out.failed[0].reason, /Could not reach/);
});

test("a dropped connection is not retried", async () => {
  const at = fakeAT(() => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })));
  const out = await client(at.fetch).send({ campaign: "rs", template: "Hi", recipients: [PEOPLE[0]] });
  assert.equal(at.calls.length, 1);
  assert.match(out.needsChecking[0].reason, /ECONNRESET/);
});

test("a 401 is a failure with the reason, not retried", async () => {
  const at = fakeAT(() => new Response("The supplied authentication is invalid", { status: 401 }));
  const out = await client(at.fetch).send({ campaign: "a", template: "Hi", recipients: [PEOPLE[0]] });
  assert.equal(at.calls.length, 1);
  assert.match(out.failed[0].reason, /refused the request \(401\): The supplied authentication is invalid/);
});

test("a number missing from the response is flagged for checking", async () => {
  const at = fakeAT(() => new Response(JSON.stringify({ SMSMessageData: { Message: "Sent to 0/1", Recipients: [] } }), { status: 201 }));
  const out = await client(at.fetch).send({ campaign: "m", template: "Hi", recipients: [PEOPLE[0]] });
  assert.match(out.needsChecking[0].reason, /Not in the response/);
});

test("parseSendResponse matches numbers in any format", () => {
  const r = parseSendResponse({ SMSMessageData: { Recipients: [{ number: "254700000101", statusCode: "102", status: "Queued", messageId: "ATXid_9", cost: "KES 0.8000" }] } }, ["+254700000101"]);
  assert.deepEqual(r.sent.map((s) => [s.phone, s.statusCode, s.messageId]), [["+254700000101", 102, "ATXid_9"]]);
});

test("config mistakes are caught early", async () => {
  assert.throws(() => createSmsClient({ mode: "production" }), /sandbox" or "live/);
  assert.throws(() => createSmsClient({ batchSize: 0 }), /batchSize/);
  const at = fakeAT();
  await assert.rejects(createSmsClient({ mode: "live", username: "sandbox", apiKey: KEY, fetch: at.fetch }).send({ campaign: "x", template: "Hi", recipients: PEOPLE }), /not "sandbox"/);
  await assert.rejects(createSmsClient({ username: "myapp", apiKey: KEY, fetch: at.fetch }).send({ campaign: "x", template: "Hi", recipients: PEOPLE }), /always "sandbox"/);
  await assert.rejects(client(at.fetch).send({ template: "Hi", recipients: PEOPLE }), /campaign key/);
  assert.equal(at.calls.length, 0);
  const live = createSmsClient({ mode: "live", username: "myapp", apiKey: KEY, fetch: at.fetch });
  await live.send({ campaign: "x", template: "Hi", recipients: [PEOPLE[0]] });
  assert.equal(at.calls[0].url, "https://api.africastalking.com/version1/messaging");
  assert.equal(at.calls[0].body.username, "myapp");
});

test("the ledger refuses a second claim until the first one fails", async () => {
  const ledger = createLedger();
  assert.equal((await ledger.claim("k", {})).claimed, true);
  assert.equal((await ledger.claim("k", {})).claimed, false);
  await ledger.settle("k", { status: "failed" });
  const again = await ledger.claim("k", {});
  assert.equal(again.claimed, true);
  assert.equal((await ledger.get("k")).attempts, 2);
});
