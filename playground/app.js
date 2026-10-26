// The browser playground. It imports the kit's own modules, so what you see here is what the kit does.
import { analyse, toGsmSafe, estimateCost } from "../lib/segments.js";
import { parsePhone } from "../lib/phone.js";
import { mergeAll, fieldsIn } from "../lib/template.js";
import { parseCsv } from "../lib/csv.js";

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-KE");
function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k != null && k !== false));
  return node;
}

// 1. The message
function message() {
  const a = analyse($("msg").value);
  $("m-parts").textContent = String(a.segments);
  $("m-parts-sub").textContent = `${a.length} of ${a.segments > 1 ? `${a.segments} x ${a.perSegment}` : a.perSegment} characters`;
  $("m-enc").textContent = a.encoding === "GSM-7" ? "GSM-7" : "Unicode";
  $("m-enc-sub").textContent = a.encoding === "GSM-7" ? "160 per SMS" : "70 per SMS, not 160";
  const recipients = Math.max(1, Math.floor(Number($("recipients").value) || 1));
  const units = a.segments * recipients;
  let cost = null;
  try { cost = estimateCost({ segments: a.segments, recipients, rate: $("rate").value }); } catch { cost = null; }
  $("m-cost").textContent = `${nf.format(recipients)} people x ${a.segments} ${a.segments === 1 ? "part" : "parts"} = ${nf.format(units)} SMS units${cost == null ? ". Add your price per SMS to see shillings." : `, about KES ${nf.format(cost)}.`}`;

  const issues = [];
  if (a.unicodeChars.length) {
    const plain = analyse(toGsmSafe($("msg").value));
    issues.push(el("div", { className: "notice" },
      el("strong", { textContent: "These characters switch the whole message to Unicode:" }),
      el("ul", { className: "chars" }, ...a.unicodeChars.map((c) => el("li", {}, el("b", { textContent: c.char === " " ? "space" : c.char }), `${c.name}, ${c.count}x${c.swap != null ? `, swap for "${c.swap}"` : ""}`))),
      plain.encoding === "GSM-7" ? el("p", { textContent: `"Make it GSM-safe" fixes all of them: ${plain.segments} ${plain.segments === 1 ? "part" : "parts"} instead of ${a.segments}.` }) : el("p", { textContent: "Some of them have no plain swap (emoji, letters outside the GSM alphabet). Remove them by hand or accept the Unicode price." })));
  }
  if (a.extensionChars.length) {
    issues.push(el("p", { className: "hint", textContent: `${a.extensionChars.map((c) => c.char).join(" ")} stay in GSM-7 but count as 2 characters each.` }));
  }
  for (const w of a.warnings) issues.push(el("p", { className: "notice", textContent: w }));
  $("m-issues").replaceChildren(...issues);
  $("safe").disabled = toGsmSafe($("msg").value) === $("msg").value;
}

// 2. The phone list
function phones() {
  const lines = $("phones").value.split(/\r?\n/);
  const seen = new Set();
  const bad = [];
  const clean = [];
  let dupes = 0;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const p = parsePhone(line);
    if (!p.ok) { bad.push([i + 1, line, p.reason]); return; }
    if (seen.has(p.e164)) { dupes++; bad.push([i + 1, line, `Same person as an earlier line (${p.e164}).`]); return; }
    seen.add(p.e164);
    clean.push(p.e164);
  });
  $("p-ok").textContent = nf.format(clean.length);
  $("p-out").textContent = nf.format(bad.length);
  $("p-out-sub").textContent = bad.length ? `${dupes} duplicates, ${bad.length - dupes} not valid` : "nothing";
  $("cleaned").value = clean.join("\n");
  const body = $("p-bad").tBodies[0];
  body.replaceChildren(...bad.slice(0, 200).map(([n, raw, why]) => el("tr", {}, el("td", { className: "num", textContent: String(n) }), el("td", {}, el("code", { textContent: raw })), el("td", { textContent: why }))));
  $("p-bad").hidden = !bad.length;
}

// 3. Mail merge
function merge() {
  const tpl = $("tpl").value;
  let people = [];
  try { people = parseCsv($("people").value).filter((r) => Object.values(r).some((v) => String(v).trim())); } catch { people = []; }
  const table = $("mg-table");
  if (!tpl.trim() || !people.length) { table.hidden = true; $("mg-sum").textContent = ""; return; }
  const out = mergeAll(tpl, people);
  const fields = fieldsIn(tpl);
  const units = out.reduce((s, x) => s + x.segments, 0);
  const flagged = out.filter((x) => x.warnings.length || x.missing.length).length;
  $("mg-sum").textContent = `${out.length} messages, ${nf.format(units)} SMS units in total. ${flagged ? `${flagged} ${flagged === 1 ? "person needs" : "people need"} a look.` : "No surprises."}${fields.length ? ` Fields used: ${fields.join(", ")}.` : ""}`;
  table.tBodies[0].replaceChildren(...out.map((x) => el("tr", { className: x.warnings.length || x.missing.length ? "" : "ok-row" },
    el("td", { textContent: x.person.first_name || x.person.name || `Row ${x.index + 2}` }),
    el("td", { className: "msg", textContent: x.text }),
    el("td", { className: "num", textContent: String(x.segments) }),
    el("td", { textContent: [...x.warnings, ...(x.missing.length ? [`Missing ${x.missing.join(", ")}: left blank.`] : [])].join(" ") || "Fine" }))));
  table.hidden = false;
}

const TRAPS = "Hi \u{1F44B} Don\u2019t miss Demo Day \u2013 Thursday 9am at the hub\u2026 Bring your laptop & pitch deck. Reply STOP to opt out.";
const MESSY = ["0712 345 678", "+254712345678", "254 712 345 678", "0712-345-679", "712345680", "0812 345 678", "+255 712 345 678", "07123456", "(0110) 000-104", "0110000104", "call me on 0722"].join("\n");
const PEOPLE = "first_name,phone\nAkinyi,0700000101\nBaraka,0700000102\nNg\u0169g\u0129,0700000103\nNyokabi-Wanjiru Kamau-Mwangi,0700000104\n,0700000105";
const TEMPLATE = "Hi {{first_name}}, your Demo Day slot is Thursday 9am at the hub. Bring your laptop and pitch deck. Reply STOP to opt out.";

$("msg").addEventListener("input", message);
$("recipients").addEventListener("input", message);
$("rate").addEventListener("input", message);
$("safe").addEventListener("click", () => { $("msg").value = toGsmSafe($("msg").value); message(); });
$("msg-sample").addEventListener("click", () => { $("msg").value = TRAPS; message(); });
$("phones").addEventListener("input", phones);
$("ph-sample").addEventListener("click", () => { $("phones").value = MESSY; phones(); });
$("tpl").addEventListener("input", merge);
$("people").addEventListener("input", merge);
$("mg-sample").addEventListener("click", () => { $("tpl").value = TEMPLATE; $("people").value = PEOPLE; merge(); });

$("phones").value = MESSY;
$("tpl").value = TEMPLATE;
$("people").value = PEOPLE;
message();
phones();
merge();
