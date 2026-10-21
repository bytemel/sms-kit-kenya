// A small CSV reader for recipient lists: a header row, commas, quoted fields with commas or line
// breaks inside, "" for a quote, Windows line endings and the byte order mark Excel adds.

export function parseCsv(text) {
  const src = String(text).replace(/^\ufeff/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }

  const filled = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (!filled.length) return [];
  const header = filled[0].map((h) => h.trim());
  return filled.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}
