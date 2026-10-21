import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePhone, normalisePhone } from "../lib/phone.js";

test("every common way of writing a Kenyan mobile number gives one E.164 form", () => {
  const same = ["0712345678", "0712 345 678", "0712-345-678", "(0712) 345 678", "+254712345678", "+254 712 345 678",
    "254712345678", "712345678", "00254712345678", "+254 (0) 712 345 678", " 0712.345.678 ", "0712\u00a0345\u00a0678"];
  for (const input of same) assert.equal(normalisePhone(input), "+254712345678", input);
});

test("01 numbers work the same as 07 numbers", () => {
  assert.equal(normalisePhone("0110 123 456"), "+254110123456");
  assert.equal(normalisePhone("+254 110 123 456"), "+254110123456");
  assert.equal(parsePhone("110123456").national, "0110123456");
});

test("bad numbers are refused with a reason a person can act on", () => {
  const cases = [
    ["", /No phone number/],
    [null, /No phone number/],
    ["0712 34", /Too short.*has 5/],
    ["07123456789", /Too long.*has 10/],
    ["+2547123456789", /Too long/],
    ["0712abc678", /letters or symbols/],
    ["+255712345678", /Not a Kenyan number/],
    ["+1 415 555 0100", /Not a Kenyan number/],
    ["020 2345678", /Not a mobile number/],
    ["0412345678", /Not a mobile number/],
  ];
  for (const [input, reason] of cases) {
    const r = parsePhone(input);
    assert.equal(r.ok, false, String(input));
    assert.equal(r.e164, null);
    assert.match(r.reason, reason, String(input));
  }
});
