// {{first_name}} style merge fields, checked per person before anything is sent.
//
// A field counts as missing when the person has no value for it, or the value is blank. A message
// that says "Hi , your class starts..." looks careless, so missing fields stop that person's message
// and are listed by name instead.

import { analyse } from "./segments.js";

const FIELD = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function fieldsIn(template) {
  return [...new Set([...String(template).matchAll(FIELD)].map((m) => m[1]))];
}

export function render(template, data = {}) {
  const missing = [];
  const text = String(template).replace(FIELD, (_, name) => {
    const value = data[name];
    if (value === undefined || value === null || String(value).trim() === "") {
      if (!missing.includes(name)) missing.push(name);
      return "";
    }
    return String(value).trim();
  });
  return { text, missing };
}

// Merge one template for many people. Each row says what the message will be, how many SMS parts it
// costs, and whether this person's details made it longer than the template on its own.
// The baseline is the template with every field empty, so a warning means "their name did this".
export function mergeAll(template, people, { transform = (t) => t } = {}) {
  const base = analyse(transform(String(template).replace(FIELD, "")));
  return people.map((person, index) => {
    const { text: merged, missing } = render(template, person);
    const text = transform(merged);
    const info = analyse(text);
    const warnings = [];
    if (info.encoding !== base.encoding) {
      const chars = info.unicodeChars.map((c) => c.char).join(" ");
      warnings.push(`This person's details switch the message to Unicode (${chars}), so each SMS holds 70 characters, not 160.`);
    }
    if (info.segments > base.segments) {
      warnings.push(`This person's details push the message to ${info.segments} SMS parts (the template alone is ${base.segments}).`);
    }
    return { index, person, text, missing, ...info, warnings };
  });
}
