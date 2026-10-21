#!/usr/bin/env node
// SMS kit command line.
//
//   node bin/sms.js check "Hi Akinyi, see you at 6pm"
//   node bin/sms.js send --csv sample/people.csv --template "Hi {{first_name}}, ..." --dry-run
//   node bin/sms.js send --csv people.csv --template "..." --campaign oct-reminder --sandbox
//   node bin/sms.js send --csv people.csv --template "..." --campaign oct-reminder --live
//   node bin/sms.js pending
//   node bin/sms.js resolve <key> --sent --message-id ATXid_...   (or --failed)
//
// With no --sandbox or --live flag, send only prints the plan. Nothing leaves your machine.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { analyse, toGsmSafe, LIMITS } from "../lib/segments.js";
import { parseCsv } from "../lib/csv.js";
import { createSmsClient, createLedger } from "../lib/client.js";
import { createJsonFileStore } from "../lib/store.js";
import { createJsonFileOptOutStore } from "../lib/optout.js";

const HELP = `Usage:
  node bin/sms.js check "your message"
  node bin/sms.js send --csv FILE --template TEXT [--campaign KEY] [--dry-run | --sandbox | --live]
      [--phone-column phone] [--rate KES_PER_SMS_PART] [--sender-id NAME] [--batch-size 100] [--data-dir data]
  node bin/sms.js pending [--data-dir data]
  node bin/sms.js resolve KEY (--sent [--message-id ID] | --failed) [--data-dir data]

send prints the plan unless you add --sandbox or --live. A real send needs --campaign: it is how a
second run knows who already got the message. --live also needs AT_USERNAME and AT_API_KEY.
pending lists sends whose outcome is unknown. After checking the Africa's Talking dashboard, resolve
each one: --sent if it went out (it stays skipped), --failed if it did not (the next run sends it).`;

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const cut = (s, n) => (s.length > n ? s.slice(0, n - 3) + "..." : s);

function check(text, out) {
  const a = analyse(text);
  const lim = LIMITS[a.encoding];
  out(`Encoding:  ${a.encoding} (${lim.single} characters in one SMS, ${lim.part} per part when longer)`);
  out(`Length:    ${a.length} characters, ${a.segments} SMS part${a.segments === 1 ? "" : "s"}`);
  if (a.unicodeChars.length) {
    out("\nThese characters switched the message to Unicode:");
    for (const c of a.unicodeChars) {
      const fix = c.swap === null ? "no plain swap, remove or reword it" : c.swap === "" ? "remove it (invisible)" : `swap for ${c.swap === " " ? "a plain space" : c.swap}`;
      out(`  ${pad(JSON.stringify(c.char), 8)} ${pad(c.code, 8)} x${pad(c.count, 3)} ${fix}`);
    }
  }
  if (a.extensionChars.length) {
    out(`\nThese cost 2 characters each: ${a.extensionChars.map((c) => `${c.char} x${c.count}`).join(", ")}`);
  }
  for (const w of a.warnings) out(`\nNote: ${w}`);
  const safe = toGsmSafe(text);
  if (safe !== text) {
    const b = analyse(safe);
    out(`\nWith plain quotes, dashes and spaces: ${b.encoding}, ${b.length} characters, ${b.segments} SMS part${b.segments === 1 ? "" : "s"}.`);
    out(safe);
  }
  return 0;
}

function printPlan(result, out) {
  const rows = result.messages || [];
  out(`${pad("#", 4)} ${pad("Phone", 14)} ${pad("Enc", 6)} ${pad("Parts", 5)} ${pad("Chars", 5)} Message`);
  for (const m of rows) {
    out(`${pad(m.index + 1, 4)} ${pad(m.phone, 14)} ${pad(m.encoding, 6)} ${pad(m.segments, 5)} ${pad(m.length, 5)} ${cut(m.text.replace(/\s+/g, " "), 60)}`);
    for (const w of m.warnings) out(`     ! ${w}`);
  }
  printSkips(result, out);
  const t = result.totals;
  out(`\n${t.recipients} message${t.recipients === 1 ? "" : "s"}, ${t.segments} SMS part${t.segments === 1 ? "" : "s"} in total.`);
  out(t.estimatedCost === null ? "Cost: add --rate (KES per SMS part, from your Africa's Talking price list) to estimate it." : `Estimated cost: KES ${t.estimatedCost.toFixed(2)} at KES ${t.rate} per SMS part.`);
}

function printSkips(result, out) {
  if (result.skipped.length) {
    out("\nSkipped:");
    for (const s of result.skipped) out(`  row ${s.index + 1} ${s.phone ?? ""}: ${s.reason}`);
  }
  if (result.needsChecking.length) {
    out("\nNeeds checking (not sent again on purpose):");
    for (const s of result.needsChecking) out(`  row ${s.index + 1} ${s.phone}: ${s.reason}${s.key ? ` Key: ${s.key}` : ""}`);
  }
}

async function send(args, { env, out, fetch }) {
  if (!args.csv || !args.template) { out(HELP); return 2; }
  const modes = ["dry-run", "sandbox", "live"].filter((m) => args[m]);
  if (modes.length > 1) { out("Choose one of --dry-run, --sandbox or --live."); return 2; }
  const mode = modes[0] || "dry-run";
  if (mode !== "dry-run" && !args.campaign) { out("A real send needs --campaign, for example --campaign class-reminder-2026-10-21."); return 2; }
  if (mode !== "dry-run" && !env.AT_API_KEY) { out("Set AT_API_KEY first (a sandbox key for --sandbox, your live key for --live)."); return 2; }
  if (mode === "live" && !env.AT_USERNAME) { out("Set AT_USERNAME to your live app username first."); return 2; }

  const people = parseCsv(await readFile(args.csv, "utf8"));
  const dataDir = args["data-dir"] || env.DATA_DIR || "data";
  const sms = createSmsClient({
    mode: mode === "live" ? "live" : "sandbox",
    username: mode === "live" ? env.AT_USERNAME : "sandbox",
    apiKey: env.AT_API_KEY,
    senderId: args["sender-id"] || env.AT_SENDER_ID || undefined,
    batchSize: args["batch-size"] ? Number(args["batch-size"]) : undefined,
    rate: args.rate ?? env.SMS_RATE_PER_SEGMENT ?? undefined,
    ledger: ledgerAt(dataDir),
    optOuts: createJsonFileOptOutStore(join(dataDir, "optouts.json")),
    fetch,
  });
  const result = await sms.send({
    campaign: args.campaign || "dry-run",
    template: args.template,
    recipients: people,
    phoneField: args["phone-column"] || "phone",
    dryRun: mode === "dry-run",
  });

  if (mode === "dry-run") {
    out(`Dry run: nothing was sent. ${people.length} row${people.length === 1 ? "" : "s"} read from ${args.csv}.\n`);
    printPlan(result, out);
    return 0;
  }
  out(`${mode === "live" ? "LIVE" : "Sandbox"} send, campaign "${args.campaign}".`);
  for (const s of result.sent) out(`  sent    ${s.phone} ${s.messageId ?? ""} ${s.cost ?? ""}`);
  for (const f of result.failed) out(`  failed  ${f.phone}: ${f.reason}`);
  printSkips(result, out);
  out(`\n${result.sent.length} sent, ${result.failed.length} failed, ${result.skipped.length} skipped, ${result.needsChecking.length} need checking.`);
  return result.failed.length || result.needsChecking.length ? 1 : 0;
}

const ledgerAt = (dataDir) => createLedger(createJsonFileStore(join(dataDir, "ledger.json")));

async function pending(args, { env, out }) {
  const rows = (await ledgerAt(args["data-dir"] || env.DATA_DIR || "data").all()).filter((r) => r.status === "pending");
  if (!rows.length) { out("Nothing pending."); return 0; }
  for (const r of rows) out(`${r.key}  ${r.phone}  campaign "${r.campaign}"  since ${r.claimedAt}`);
  out(`\n${rows.length} pending. Check each in the Africa's Talking dashboard, then run resolve.`);
  return 0;
}

async function resolve(key, args, { env, out }) {
  if (!key || args.sent === args.failed) { out("Usage: node bin/sms.js resolve KEY --sent [--message-id ID]  or  --failed"); return 2; }
  const status = args.sent ? "sent" : "failed";
  const extra = args["message-id"] ? { messageId: args["message-id"] } : {};
  const row = await ledgerAt(args["data-dir"] || env.DATA_DIR || "data").resolve(key, status, extra);
  if (!row) { out(`No pending send with key ${key}. Run pending to list them.`); return 1; }
  out(`Marked ${row.phone} as ${status}. ${status === "sent" ? "Later runs skip it." : "The next run sends it."}`);
  return 0;
}

export async function main(argv, { env = process.env, out = console.log, fetch = globalThis.fetch } = {}) {
  const [command, ...rest] = argv;
  if (command === "pending" || command === "resolve") {
    let parsed;
    try {
      parsed = parseArgs({ args: rest, allowPositionals: true, options: {
        "data-dir": { type: "string" }, sent: { type: "boolean" }, failed: { type: "boolean" }, "message-id": { type: "string" },
      } });
    } catch (err) {
      out(`${err.message}\n\n${HELP}`);
      return 2;
    }
    return command === "pending" ? pending(parsed.values, { env, out }) : resolve(parsed.positionals[0], parsed.values, { env, out });
  }
  if (command === "check") {
    if (!rest.length) { out('Usage: node bin/sms.js check "your message"'); return 2; }
    return check(rest.join(" "), out);
  }
  if (command === "send") {
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        options: {
          csv: { type: "string" }, template: { type: "string" }, campaign: { type: "string" },
          "phone-column": { type: "string" }, rate: { type: "string" }, "sender-id": { type: "string" },
          "batch-size": { type: "string" }, "data-dir": { type: "string" },
          "dry-run": { type: "boolean" }, sandbox: { type: "boolean" }, live: { type: "boolean" },
        },
      });
    } catch (err) {
      out(`${err.message}\n\n${HELP}`);
      return 2;
    }
    try {
      return await send(parsed.values, { env, out, fetch });
    } catch (err) {
      out(`Error: ${err.message}`);
      return 1;
    }
  }
  out(HELP);
  return command ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
