// Small RFC-4180-ish CSV/TSV reader (quotes, embedded commas/newlines).
export function parseRows(text, delim) {
  const t = String(text).replace(/^﻿/, '');
  if (!delim) { const first = t.split(/\r?\n/).find((l) => l.trim()) || ''; delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ','; }
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else f += ch;
  }
  row.push(f); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
export function parseCSV(text) {
  const rows = parseRows(text);
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
