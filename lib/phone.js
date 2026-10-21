// Kenyan mobile numbers in, one E.164 form out: +254 followed by 9 digits.
//
// People type numbers every way: 0712 345 678, 0112-345-678, +254 712 345678, 254712345678,
// 712345678, (0712) 345 678, 00254712345678, +254 (0) 712 345 678. All of these are the same phone.
//
// This file does not keep a table of which prefix belongs to Safaricom, Airtel or Telkom. People keep
// their number when they switch networks, so a prefix table goes stale and I could not find a primary
// source I trust for a current one. It only checks the shape: 9 digits after 254, starting with 7 or 1,
// the two mobile ranges (07xx and 01xx). Landlines (020 and so on) are refused with a reason.

const SEPARATORS = /[\s\-().\/\u00a0]/g;

export function parsePhone(input) {
  if (input === null || input === undefined) return fail(input, "No phone number given.");
  const raw = String(input).trim();
  if (!raw) return fail(input, "No phone number given.");

  let s = raw.replace(SEPARATORS, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  const plus = s.startsWith("+");
  if (plus) s = s.slice(1);
  if (!/^\d+$/.test(s)) return fail(input, "Has letters or symbols in it. Use digits only, with an optional + at the start.");

  let national;
  if (s.startsWith("254")) {
    national = s.slice(3);
    if (national.length === 10 && national.startsWith("0")) national = national.slice(1); // +254 (0) 712...
  } else if (plus) {
    return fail(input, "Not a Kenyan number. It should start with +254.");
  } else if (s.startsWith("0")) {
    national = s.slice(1);
  } else {
    national = s;
  }

  if (national.length < 9) return fail(input, `Too short: a Kenyan mobile number has 9 digits after 0 or 254, this has ${national.length}.`);
  if (national.length > 9) return fail(input, `Too long: a Kenyan mobile number has 9 digits after 0 or 254, this has ${national.length}.`);
  if (!/^[71]/.test(national)) return fail(input, "Not a mobile number. Kenyan mobile numbers start with 07 or 01.");

  return { ok: true, e164: `+254${national}`, national: `0${national}`, input };
}

function fail(input, reason) {
  return { ok: false, e164: null, input, reason };
}

// The E.164 string, or null when the number is not valid.
export function normalisePhone(input) {
  return parsePhone(input).e164;
}
