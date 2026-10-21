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
