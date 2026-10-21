import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../bin/sms.js";

const run = async (argv, opts = {}) => {
  const lines = [];
  const code = await main(argv, { env: {}, out: (s) => lines.push(s), fetch: () => { throw new Error("no network in tests"); }, ...opts });
  return { code, text: lines.join("\n") };
};

test("check prints encoding, parts and the characters to fix", async () => {
  const { code, text } = await run(["check", "Don\u2019t be late \u2013 6pm \u{1F389}"]);
  assert.equal(code, 0);
  assert.match(text, /Encoding:\s+UCS-2/);
  assert.match(text, /U\+2019 .*swap for '/);
  assert.match(text, /U\+1F389 .*no plain swap/);
  assert.match(text, /With plain quotes/);
  const plain = await run(["check", "Class at 6pm. Cost: 500 KES"]);
  assert.match(plain.text, /GSM-7.*\n.*27 characters, 1 SMS part$/m);
});

test("send with --dry-run prints the plan as a table and sends nothing", async () => {
  const { code, text } = await run(["send", "--csv", "sample/people.csv", "--template", "Hi {{first_name}}, see you Saturday at 10am.", "--dry-run", "--rate", "0.8"]);
  assert.equal(code, 0);
  assert.match(text, /Dry run: nothing was sent/);
  assert.match(text, /^#\s+Phone\s+Enc\s+Parts\s+Chars\s+Message$/m);
  assert.match(text, /\+254700000101\s+GSM-7\s+1\s+/);
  assert.match(text, /Listed more than once/);
  assert.match(text, /Too short/);
  assert.match(text, /switch the message to Unicode/);
  assert.match(text, /Estimated cost: KES \d+\.\d\d at KES 0\.8 per SMS part/);
});

test("no mode flag means a dry run; no rate means no cost guess", async () => {
  const { text } = await run(["send", "--csv", "sample/people.csv", "--template", "Hi"]);
  assert.match(text, /Dry run/);
  assert.match(text, /add --rate/);
});

test("real sends need a campaign, keys, and one mode", async () => {
  const base = ["send", "--csv", "sample/people.csv", "--template", "Hi"];
  assert.match((await run([...base, "--live"])).text, /needs --campaign/);
  assert.match((await run([...base, "--live", "--campaign", "c"])).text, /Set AT_API_KEY/);
  assert.match((await run([...base, "--live", "--campaign", "c"], { env: { AT_API_KEY: "k" } })).text, /Set AT_USERNAME/);
  assert.match((await run([...base, "--live", "--sandbox"])).text, /Choose one/);
  assert.equal((await run(["send", "--nope"])).code, 2);
});

test("a sandbox send goes to the sandbox URL and writes the ledger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sms-kit-cli-"));
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    const to = new URLSearchParams(init.body).get("to").split(",");
    return new Response(JSON.stringify({ SMSMessageData: { Recipients: to.map((number, i) => ({ number, statusCode: 101, status: "Success", messageId: `ATXid_${calls.length}_${i}`, cost: "KES 0.8000" })) } }), { status: 201 });
  };
  try {
    const args = ["send", "--csv", "sample/people.csv", "--template", "Hi {{first_name}}", "--campaign", "cli-test", "--sandbox", "--data-dir", dir];
    const first = await run(args, { env: { AT_API_KEY: "sandbox_key" }, fetch });
    assert.match(first.text, /Sandbox send/);
    assert.match(first.text, /7 sent, 0 failed, 2 skipped/);
    assert.ok(calls.every((u) => u === "https://api.sandbox.africastalking.com/version1/messaging"));
    const again = await run(args, { env: { AT_API_KEY: "sandbox_key" }, fetch });
    assert.match(again.text, /0 sent, 0 failed, 9 skipped/);
    assert.equal(calls.length, 7);
    assert.equal(Object.keys(JSON.parse(await readFile(join(dir, "ledger.json"), "utf8"))).length, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pending lists unknown outcomes, and resolve settles them by hand", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sms-kit-resolve-"));
  let posts = 0;
  const fetch = async (url, init) => {
    posts++;
    if (posts === 1) return new Response("bad gateway", { status: 502 });
    const to = new URLSearchParams(init.body).get("to").split(",");
    return new Response(JSON.stringify({ SMSMessageData: { Recipients: to.map((number) => ({ number, statusCode: 101, status: "Success", messageId: "ATXid_ok", cost: "KES 0.8000" })) } }), { status: 201 });
  };
  try {
    const env = { AT_API_KEY: "sandbox_key" };
    const csv = join(dir, "one.csv");
    await (await import("node:fs/promises")).writeFile(csv, "phone\n0700000101\n");
    const args = ["send", "--csv", csv, "--template", "Hi", "--campaign", "res", "--sandbox", "--data-dir", dir];
    const first = await run(args, { env, fetch });
    assert.equal(first.code, 1);
    const key = first.text.match(/Key: ([a-f0-9]{64})/)[1];
    const list = await run(["pending", "--data-dir", dir]);
    assert.match(list.text, new RegExp(`${key}\\s+\\+254700000101\\s+campaign "res"`));
    assert.match((await run(args, { env, fetch })).text, /0 sent, 0 failed, 0 skipped, 1 need checking/);
    assert.equal(posts, 1);
    assert.equal((await run(["resolve", key, "--data-dir", dir])).code, 2);
    const done = await run(["resolve", key, "--failed", "--data-dir", dir]);
    assert.match(done.text, /Marked \+254700000101 as failed. The next run sends it/);
    assert.equal((await run(["resolve", key, "--sent", "--data-dir", dir])).code, 1);
    assert.match((await run(args, { env, fetch })).text, /1 sent, 0 failed/);
    assert.equal(posts, 2);
    assert.match((await run(["pending", "--data-dir", dir])).text, /Nothing pending/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
