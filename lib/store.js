// A tiny key value store with two backends, used for the send ledger, opt-outs and delivery statuses.
//
//   get(key)                     the value or null
//   set(key, value)              save it
//   delete(key)                  remove it
//   entries()                    every [key, value] pair
//   update(key, fn)              read, change and write one key with no other write in between.
//                                fn(current) returns the new value, or undefined to leave it alone.
//
// The memory store forgets everything on restart. The JSON file store keeps it in one file and is safe
// inside one Node process. Two processes writing at the same moment can still lose a write: use a
// database for that (the README has the Postgres tables).

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export function createMemoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : null; },
    async set(key, value) { map.set(key, structuredClone(value)); },
    async delete(key) { map.delete(key); },
    async entries() { return [...map.entries()].map(([k, v]) => [k, structuredClone(v)]); },
    async update(key, fn) {
      const next = fn(map.has(key) ? structuredClone(map.get(key)) : null);
      if (next !== undefined) map.set(key, structuredClone(next));
      return next === undefined ? null : structuredClone(next);
    },
  };
}

export function createJsonFileStore(path) {
  let queue = Promise.resolve();

  // Read the file every time, so a server and the command line sharing one file see each other's
  // changes. Fine for the few thousand rows a JSON file is good for.
  async function load() {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw new Error(`Could not read ${path}: ${err.message}`);
      return {};
    }
  }

  async function save(data) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
    await rename(tmp, path); // a crash mid write leaves the old file whole
  }

  // Every change waits for the one before it, so two quick writes cannot overwrite each other.
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  return {
    async get(key) { const d = await load(); return key in d ? structuredClone(d[key]) : null; },
    set: (key, value) => serial(async () => { const d = await load(); d[key] = structuredClone(value); await save(d); }),
    delete: (key) => serial(async () => { const d = await load(); delete d[key]; await save(d); }),
    async entries() { const d = await load(); return Object.entries(structuredClone(d)); },
    update: (key, fn) => serial(async () => {
      const d = await load();
      const next = fn(key in d ? structuredClone(d[key]) : null);
      if (next === undefined) return null;
      d[key] = structuredClone(next);
      await save(d);
      return structuredClone(next);
    }),
  };
}
