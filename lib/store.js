// A tiny key value store with two backends, used for the send ledger, opt-outs and delivery statuses.
//
//   get(key)                     the value or null
//   set(key, value)              save it
//   delete(key)                  remove it
//   entries()                    every [key, value] pair
//   update(key, fn)              read, change and write one key with no other write in between.
//                                fn(current) returns the new value, or undefined to leave it alone.
//
// The memory store forgets everything on restart. The JSON file store keeps it in one file. Every
// change takes a lock file next to it first, so several processes on one machine (the server and two
// command line runs, say) can share the file without losing a write or claiming the same key twice.
// A lock file only works on one machine's disk: across machines, use a database (see the README).

import { readFile, writeFile, rename, mkdir, open, stat, unlink } from "node:fs/promises";
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

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Hold `${path}.lock` while fn runs. The file is created with the "wx" flag, which fails when it
// already exists, so only one process at a time gets it. A lock older than staleMs is left over from
// a process that crashed, and is removed.
async function withFileLock(path, fn, { timeoutMs, staleMs }) {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true });
  let handle;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > staleMs) { await unlink(lockPath).catch(() => {}); continue; }
      if (Date.now() > deadline) throw new Error(`Could not lock ${path} within ${timeoutMs / 1000} seconds. If no other run is going, delete ${lockPath}.`);
      await pause(wait + Math.random() * wait);
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

export function createJsonFileStore(path, { lockTimeoutMs = 10000, staleLockMs = 30000 } = {}) {
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

  // Every change waits for the one before it in this process, then takes the file lock, so no
  // other process can write between this read and this write.
  const serial = (body) => {
    const fn = () => withFileLock(path, body, { timeoutMs: lockTimeoutMs, staleMs: staleLockMs });
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
