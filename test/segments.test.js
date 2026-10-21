import { test } from "node:test";
import assert from "node:assert/strict";
import { analyse, toGsmSafe, estimateCost, isGsmBasic, isGsmExtension } from "../lib/segments.js";

const a = (n) => "a".repeat(n);

test("GSM-7: 160 is one SMS, 161 is two, then 153 per part", () => {
  assert.deepEqual([0, 1, 160, 161, 306, 307].map((n) => analyse(a(n)).segments), [0, 1, 1, 2, 2, 3]);
  const r = analyse(a(161));
  assert.equal(r.encoding, "GSM-7");
  assert.equal(r.perSegment, 153);
  assert.equal(analyse(a(160)).perSegment, 160);
});

test("UCS-2: one non-GSM character makes 70 the limit, then 67 per part", () => {
  const u = (n) => "\u00eb" + a(n - 1);
  assert.deepEqual([70, 71, 134, 135].map((n) => analyse(u(n)).segments), [1, 2, 2, 3]);
  assert.equal(analyse(u(70)).encoding, "UCS-2");
});

test("extension characters cost 2, including at the 160 boundary", () => {
  assert.equal(analyse(a(158) + "\u20ac").length, 160);
  assert.equal(analyse(a(158) + "\u20ac").segments, 1);
  assert.equal(analyse(a(159) + "\u20ac").segments, 2);
  assert.equal(analyse(a(159) + "\u20ac").encoding, "GSM-7");
  const r = analyse("{[x]}~^|\\\f");
  assert.equal(r.length, 9 * 2 + 1);
  assert.deepEqual(r.extensionChars.map((c) => c.char).sort(), ["\f", "[", "\\", "]", "^", "{", "|", "}", "~"].sort());
});

test("an escape pair is never split across parts", () => {
  // 152 + 2 + 152 = 306 units. Simple division says 2 parts, but the euro sign cannot fit in part 1.
  assert.equal(analyse(a(152) + "\u20ac" + a(152)).segments, 3);
  assert.equal(analyse(a(151) + "\u20ac" + a(153)).segments, 2);
});

test("emoji are surrogate pairs: 2 units each, never split", () => {
  const party = "\u{1F389}";
  assert.equal(analyse(party).length, 2);
  assert.equal(analyse(party).characters, 1);
  assert.equal(analyse(party.repeat(35)).segments, 1);
  assert.equal(analyse(party.repeat(36)).segments, 2);
  assert.equal(analyse(a(66) + party + a(66)).segments, 3);
  assert.equal(analyse(a(65) + party + a(67)).segments, 2);
  const r = analyse("See you " + party);
  assert.deepEqual(r.unicodeChars.map((c) => [c.code, c.swap]), [["U+1F389", null]]);
});

test("the characters that forced Unicode are listed with counts and swaps", () => {
  const r = analyse("Don\u2019t forget \u2013 6pm\u2026 it\u2019s on");
  assert.equal(r.encoding, "UCS-2");
  const byChar = Object.fromEntries(r.unicodeChars.map((c) => [c.char, c]));
  assert.equal(byChar["\u2019"].count, 2);
  assert.equal(byChar["\u2019"].swap, "'");
  assert.equal(byChar["\u2013"].swap, "-");
  assert.equal(byChar["\u2026"].swap, "...");
});

test("the GSM alphabet is the 3GPP one: lowercase c cedilla, backtick and tab are not in it", () => {
  for (const c of ["@", "\u00a3", "\u00c7", "\u0394", "\u00a4", "\u00bf", "\u00e0", "\n", "\r"]) assert.ok(isGsmBasic(c), c);
  for (const c of ["\u00e7", "`", "\t", "\u00eb"]) assert.equal(isGsmBasic(c) || isGsmExtension(c), false, c);
  assert.ok(isGsmExtension("\u20ac"));
});

test("toGsmSafe swaps curly quotes, long dashes, ellipsis and odd spaces, and leaves emoji", () => {
  const input = "\u201cHi\u201d \u2018Akinyi\u2019 \u2013 \u2014 \u2026 a\u00a0b\u202fc\u200bd \u2022 x";
  const out = toGsmSafe(input);
  assert.equal(out, "\"Hi\" 'Akinyi' - - ... a b cd - x");
  assert.equal(analyse(out).encoding, "GSM-7");
  assert.equal(toGsmSafe("ok \u{1F389}"), "ok \u{1F389}");
});

test("a % sign comes with a warning", () => {
  assert.equal(analyse("50% off").warnings.length, 1);
  assert.equal(analyse("half off").warnings.length, 0);
});

test("cost is segments x recipients x rate, and only when a rate is given", () => {
  assert.equal(estimateCost({ segments: 2, recipients: 3 }), null);
  assert.equal(estimateCost({ segments: 2, recipients: 3, rate: "0.8" }), 4.8);
  assert.equal(estimateCost({ segments: 7, rate: 0.8 }), 5.6);
  assert.throws(() => estimateCost({ segments: 1, rate: "cheap" }), /number of shillings/);
  assert.throws(() => estimateCost({ segments: 1, rate: -1 }), /number of shillings/);
});
