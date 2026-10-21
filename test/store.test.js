import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, createJsonFileStore } from "../lib/store.js";
import { parseCsv } from "../lib/csv.js";

for (const [name, make] of [["memory", async () => [createMemoryStore(), null]], ["json file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sms-kit-store-"));
  return [createJsonFileStore(join(dir, "nested", "s.json")), dir];
}]]) {
  test(`${name} store: get, set, update, delete, and copies not references`, async () => {
    const [kv, dir] = await make();
    try {
      assert.equal(await kv.get("k"), null);
      const v = { n: 1 };
      await kv.set("k", v);
      v.n = 99;
      assert.deepEqual(await kv.get("k"), { n: 1 });
      assert.deepEqual(await kv.update("k", (cur) => ({ n: cur.n + 1 })), { n: 2 });
      assert.equal(await kv.update("k", () => undefined), null);
      assert.deepEqual(await kv.get("k"), { n: 2 });
      const many = await Promise.all(Array.from({ length: 20 }, () => kv.update("c", (cur) => ({ n: (cur?.n || 0) + 1 }))));
      assert.equal(many.length, 20);
      assert.deepEqual(await kv.get("c"), { n: 20 });
      await kv.delete("k");
      assert.deepEqual((await kv.entries()).map(([k]) => k), ["c"]);
      if (dir) assert.deepEqual(await readdir(join(dir, "nested")), ["s.json"]);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
}

test("csv: quotes, commas and line breaks inside quotes, CRLF, BOM and blank lines", () => {
  const text = "\ufefffirst_name,phone,note\r\n\"Otieno, Akinyi\",0712345678,\"said \"\"hi\"\"\nthen left\"\r\n\r\nBaraka,0700000102,\n";
  assert.deepEqual(parseCsv(text), [
    { first_name: "Otieno, Akinyi", phone: "0712345678", note: 'said "hi"\nthen left' },
    { first_name: "Baraka", phone: "0700000102", note: "" },
  ]);
  assert.deepEqual(parseCsv(""), []);
});

test("two JSON file stores on one file see each other's writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sms-kit-shared-"));
  try {
    const a = createJsonFileStore(join(dir, "s.json"));
    const b = createJsonFileStore(join(dir, "s.json"));
    await a.get("x");
    await b.set("from-b", 1);
    await a.set("from-a", 2);
    assert.deepEqual((await b.entries()).map(([k]) => k).sort(), ["from-a", "from-b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("separate processes sharing one JSON ledger: only one claims a key", async () => {
  const { spawn } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "sms-kit-procs-"));
  const file = join(dir, "ledger.json");
  const lib = new URL("../lib/", import.meta.url).href;
  const script = `
    import { createJsonFileStore } from "${lib}store.js";
    import { createLedger } from "${lib}client.js";
    const start = Number(process.argv[1]); while (Date.now() < start) {}
    const ledger = createLedger(createJsonFileStore(${JSON.stringify(file)}));
    const results = [];
    for (const k of ["a", "b", "c"]) results.push((await ledger.claim(k, {})).claimed ? 1 : 0);
    console.log(results.join(""));`;
  try {
    const start = Date.now() + 400;
    const outs = await Promise.all([1, 2, 3, 4].map(() => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, String(start)]);
      let out = "";
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { out += c; });
      child.on("error", reject);
      child.on("close", () => resolve(out.trim()));
    })));
    for (let i = 0; i < 3; i++) assert.equal(outs.reduce((n, o) => n + Number(o[i]), 0), 1, `key ${i}: ${outs.join(" ")}`);
    assert.deepEqual(await readdir(dir), ["ledger.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale lock is cleared, and a live one makes a write wait then give up", async () => {
  const { writeFile, utimes } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "sms-kit-lock-"));
  const file = join(dir, "s.json");
  try {
    await writeFile(`${file}.lock`, "12345\n");
    const old = new Date(Date.now() - 60000);
    await utimes(`${file}.lock`, old, old);
    await createJsonFileStore(file).set("k", 1);
    assert.equal(await createJsonFileStore(file).get("k"), 1);

    await writeFile(`${file}.lock`, "12345\n");
    await assert.rejects(createJsonFileStore(file, { lockTimeoutMs: 50 }).set("k", 2), /Could not lock .* delete .*s\.json\.lock/);
    assert.equal(await createJsonFileStore(file).get("k"), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
