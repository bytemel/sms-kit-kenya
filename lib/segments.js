// How many SMS units a message costs, and why.
//
// A message stays in GSM-7 only when every character is in the GSM 03.38 default alphabet
// (3GPP TS 23.038). Then one SMS holds 160 characters, and a long message is split into parts of 153
// (each part spends 7 characters on a header that glues the parts back together).
// One character outside that alphabet, such as a curly apostrophe or an emoji, switches the whole
// message to UCS-2: 70 per SMS, 67 per part. Africa's Talking bills each part as one SMS.
//
// Characters from the GSM extension table (^ { } \ [ ~ ] | and the euro sign, plus form feed)
// stay in GSM-7 but cost 2, because each is sent as an escape plus the character.
// A part never splits an escape pair or an emoji's surrogate pair, so the split is done greedily.

const GSM_BASIC =
  "@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5" +
  "\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9" +
  " !\"#\u00a4%&'()*+,-./0123456789:;<=>?" +
  "\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7" +
  "\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0";
const GSM_EXTENSION = "\f^{}\\[~]|\u20ac";

const BASIC = new Set(GSM_BASIC);
const EXTENSION = new Set(GSM_EXTENSION);

export const LIMITS = {
  "GSM-7": { single: 160, part: 153 },
  "UCS-2": { single: 70, part: 67 },
};

// Plain swaps that keep a message in GSM-7. Written as escapes so the source stays plain ASCII.
const SWAPS = new Map([
  ...["\u2018", "\u2019", "\u201a", "\u201b", "\u2032", "\u00b4", "`"].map((c) => [c, "'"]),
  ...["\u201c", "\u201d", "\u201e", "\u201f", "\u2033", "\u00ab", "\u00bb"].map((c) => [c, '"']),
  ...["\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212", "\u2022", "\u00b7"].map((c) => [c, "-"]),
  ["\u2026", "..."],
  ...["\u00a0", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200a", "\u202f", "\u205f", "\u3000", "\t"].map((c) => [c, " "]),
  ...["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"].map((c) => [c, ""]),
  ["\u2206", "\u0394"],
]);

export const isGsmBasic = (ch) => BASIC.has(ch);
export const isGsmExtension = (ch) => EXTENSION.has(ch);

const codeOf = (ch) => "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");

function describe(ch) {
  const names = { "\u00a0": "non-breaking space", "\u200b": "zero-width space", "\ufeff": "invisible byte order mark", "\t": "tab" };
  return names[ch] || (SWAPS.get(ch) === " " ? "special space" : SWAPS.get(ch) === "" ? "invisible character" : ch);
}

function countParts(units, single, part) {
  const total = units.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  if (total <= single) return 1;
  let parts = 1;
  let used = 0;
  for (const u of units) {
    if (used + u > part) { parts += 1; used = 0; }
    used += u;
  }
  return parts;
}

export function analyse(text) {
  const message = String(text ?? "");
  const chars = [...message];
  const gsm = chars.every((c) => BASIC.has(c) || EXTENSION.has(c));
  const encoding = gsm ? "GSM-7" : "UCS-2";
  const { single, part } = LIMITS[encoding];
  const units = chars.map((c) => (gsm ? (EXTENSION.has(c) ? 2 : 1) : c.length));
  const length = units.reduce((a, b) => a + b, 0);
  const segments = countParts(units, single, part);

  const tally = (pick) => {
    const found = new Map();
    for (const c of chars) {
      if (!pick(c)) continue;
      const row = found.get(c) || { char: c, code: codeOf(c), name: describe(c), count: 0, swap: SWAPS.has(c) ? SWAPS.get(c) : null };
      row.count += 1;
      found.set(c, row);
    }
    return [...found.values()];
  };

  const warnings = [];
  if (message.includes("%")) warnings.push("Africa's Talking's help centre says messages with a % sign have failed to send. Test one before a big send.");

  return {
    encoding,
    length,
    characters: chars.length,
    segments,
    perSegment: segments > 1 ? part : single,
    unicodeChars: tally((c) => !BASIC.has(c) && !EXTENSION.has(c)),
    extensionChars: tally((c) => EXTENSION.has(c)),
    warnings,
  };
}

// Swap curly quotes, long dashes, the ellipsis and odd spaces for plain ones. Emoji and letters
// outside the GSM alphabet are left alone: analyse() still lists them so a person can decide.
export function toGsmSafe(text) {
  let out = "";
  for (const c of String(text ?? "")) out += SWAPS.has(c) ? SWAPS.get(c) : c;
  return out;
}

// segments x recipients x rate. There is no default rate on purpose: prices change, and a wrong
// number in a budget is worse than none. Returns null when no rate is given.
export function estimateCost({ segments, recipients = 1, rate }) {
  if (rate === undefined || rate === null || rate === "") return null;
  const r = Number(rate);
  if (!Number.isFinite(r) || r < 0) throw new Error(`The rate must be a number of shillings per SMS part, not "${rate}".`);
  return Math.round(segments * recipients * r * 10000) / 10000;
}
