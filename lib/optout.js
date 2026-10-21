// Opt-outs: who said stop, and making sure they are left out of every later send.
//
// Store interface (both versions below follow it):
//   has(phone)            true when this number opted out
//   add(phone, info)      record an opt-out. info is kept, for example { source: "reply", text: "STOP" }
//   remove(phone)         take a number off the list, only when the person asks to hear from you again
//   list()                every opted-out number with its info
// Numbers are normalised first, so 0712 345 678 and +254712345678 are the same person.

import { normalisePhone } from "./phone.js";
import { createMemoryStore, createJsonFileStore } from "./store.js";

// Replies that mean "stop sending me messages". SIMAMA and ACHA are Swahili for stop.
export const STOP_WORDS = ["STOP", "STOP ALL", "STOPALL", "UNSUBSCRIBE", "SIMAMA", "ACHA"];

// True when a reply is an opt-out. Forgiving about case, spaces and trailing punctuation.
// The reply must be the stop word alone, or the stop word plus one more word (people often add the
// sender name: "STOP EPICPRIME"). A longer sentence is not treated as an opt-out, because in Swahili
// "acha" also starts ordinary sentences ("Acha nikuambie..." means "let me tell you...").
export function parseOptOut(text) {
  const words = String(text ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 3) return { optOut: false, keyword: null };
  const joined = words.join(" ");
  for (const word of [...STOP_WORDS].sort((a, b) => b.length - a.length)) {
    if (joined === word) return { optOut: true, keyword: word };
    if (joined.startsWith(word + " ") && joined.slice(word.length + 1).split(" ").length === 1) return { optOut: true, keyword: word };
  }
  return { optOut: false, keyword: null };
}

// Build an opt-out store on any key value store with get, update, delete and entries (see store.js).
export function createOptOutStore(kv) {
  const key = (phone) => {
    const e164 = normalisePhone(phone);
    if (!e164) throw new Error(`Not a valid Kenyan mobile number: ${phone}`);
    return e164;
  };
  return {
    async has(phone) {
      const e164 = normalisePhone(phone);
      return e164 ? (await kv.get(e164)) !== null : false;
    },
    async add(phone, info = {}) {
      const e164 = key(phone);
      await kv.update(e164, (current) => current ?? { ...info, at: info.at || new Date().toISOString() });
      return e164;
    },
    async remove(phone) { await kv.delete(key(phone)); },
    async list() { return (await kv.entries()).map(([phone, info]) => ({ phone, ...info })); },
  };
}

export const createMemoryOptOutStore = () => createOptOutStore(createMemoryStore());
export const createJsonFileOptOutStore = (path) => createOptOutStore(createJsonFileStore(path));

// Split a recipient list into people to message and people to skip because they opted out.
export async function filterOptedOut(recipients, store, { phoneOf = (r) => r.phone } = {}) {
  const send = [];
  const skipped = [];
  for (const recipient of recipients) {
    const phone = phoneOf(recipient);
    if (await store.has(phone)) skipped.push({ recipient, phone: normalisePhone(phone), reason: "Opted out" });
    else send.push(recipient);
  }
  return { send, skipped };
}
