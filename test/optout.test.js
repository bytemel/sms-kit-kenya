import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptOut, createMemoryOptOutStore, createJsonFileOptOutStore, filterOptedOut } from "../lib/optout.js";

test("STOP style replies are understood, forgiving case, spacing and punctuation", () => {
  const yes = ["STOP", "stop", " Stop. ", "STOP ALL", "stop   all", "StopAll", "UNSUBSCRIBE", "unsubscribe!", "SIMAMA", "acha", "STOP EPICPRIME", "Stop all EpicPrime", "STOP please"];
  for (const t of yes) assert.equal(parseOptOut(t).optOut, true, t);
  assert.equal(parseOptOut("stop all").keyword, "STOP ALL");
  assert.equal(parseOptOut("simama").keyword, "SIMAMA");
});

test("ordinary messages are not opt-outs", () => {
  const no = ["", null, "Thanks!", "Acha nikuambie kitu kuhusu darasa", "Please stop by the office tomorrow", "STOPPED", "nonstop", "BUS STOP"];
  for (const t of no) assert.equal(parseOptOut(t).optOut, false, String(t));
});

test("the memory store normalises numbers", async () => {
  const store = createMemoryOptOutStore();
  assert.equal(await store.add("0712 345 678", { source: "reply" }), "+254712345678");
  assert.equal(await store.has("+254712345678"), true);
  assert.equal(await store.has("254712345678"), true);
  assert.equal(await store.has("0700000000"), false);
  assert.equal(await store.has("not a number"), false);
  await assert.rejects(store.add("12"), /Not a valid Kenyan mobile number/);
  const [row] = await store.list();
  assert.equal(row.phone, "+254712345678");
  assert.equal(row.source, "reply");
  await store.remove("0712345678");
  assert.equal(await store.has("0712345678"), false);
});

test("adding the same number twice keeps the first record", async () => {
  const store = createMemoryOptOutStore();
  await store.add("0712345678", { source: "reply", at: "2026-10-01T00:00:00.000Z" });
  await store.add("0712345678", { source: "UserInBlacklist" });
  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].source, "reply");
});

test("the JSON file store survives a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sms-kit-optout-"));
  try {
    const path = join(dir, "optouts.json");
    await createJsonFileOptOutStore(path).add("0712345678", { source: "reply" });
    assert.equal(await createJsonFileOptOutStore(path).has("+254712345678"), true);
    assert.ok(JSON.parse(await readFile(path, "utf8"))["+254712345678"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("filterOptedOut splits the list and says who was skipped", async () => {
  const store = createMemoryOptOutStore();
  await store.add("0712345678");
  const people = [{ name: "A", phone: "+254712345678" }, { name: "B", phone: "0700000102" }];
  const { send, skipped } = await filterOptedOut(people, store);
  assert.deepEqual(send.map((p) => p.name), ["B"]);
  assert.deepEqual(skipped.map((s) => [s.recipient.name, s.phone, s.reason]), [["A", "+254712345678", "Opted out"]]);
});
