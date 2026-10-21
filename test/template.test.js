import { test } from "node:test";
import assert from "node:assert/strict";
import { render, mergeAll, fieldsIn } from "../lib/template.js";
import { toGsmSafe } from "../lib/segments.js";

test("render fills fields, allows spaces in braces and lists what is missing", () => {
  assert.deepEqual(render("Hi {{first_name}}, see you {{ day }}.", { first_name: " Akinyi ", day: "Saturday" }), { text: "Hi Akinyi, see you Saturday.", missing: [] });
  const r = render("Hi {{first_name}} {{last_name}}, {{first_name}}", { first_name: "", last_name: null });
  assert.deepEqual(r.missing, ["first_name", "last_name"]);
  assert.deepEqual(fieldsIn("{{a}} {{ b }} {{a}} {single}"), ["a", "b"]);
  assert.equal(render("Price {in braces} stays", {}).text, "Price {in braces} stays");
});

test("mergeAll gives each person their text, missing fields and segment count", () => {
  const rows = mergeAll("Hi {{first_name}}, class is at 6pm.", [{ first_name: "Baraka" }, { last_name: "Otieno" }]);
  assert.equal(rows[0].text, "Hi Baraka, class is at 6pm.");
  assert.equal(rows[0].segments, 1);
  assert.deepEqual(rows[0].warnings, []);
  assert.deepEqual(rows[1].missing, ["first_name"]);
});

test("a long name that pushes the message into a second part is flagged", () => {
  const template = "Hi {{first_name}}, " + "x".repeat(140);
  const [short, long] = mergeAll(template, [{ first_name: "Ann" }, { first_name: "Wanjiku Nyambura Kamau" }]);
  assert.equal(short.segments, 1);
  assert.equal(long.segments, 2);
  assert.match(long.warnings.join(" "), /push the message to 2 SMS parts/);
});

test("a name outside the GSM alphabet is flagged as switching to Unicode", () => {
  const [row] = mergeAll("Hi {{first_name}}, see you at 6pm.", [{ first_name: "Zo\u00eb" }]);
  assert.equal(row.encoding, "UCS-2");
  assert.match(row.warnings[0], /switch the message to Unicode/);
});

test("the transform runs after the merge, so a curly apostrophe in a name is fixed too", () => {
  const [row] = mergeAll("Hi {{first_name}}", [{ first_name: "O\u2019Neil" }], { transform: toGsmSafe });
  assert.equal(row.text, "Hi O'Neil");
  assert.equal(row.encoding, "GSM-7");
});
