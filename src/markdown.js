// Minimal, safe markdown -> HTML (escapes everything first; no raw HTML passes through).
const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function inline(t) {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = []; let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); continue; }
    if (!l.trim()) { i++; continue; }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const n = Math.min(h[1].length + 1, 5); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push('<div class="tbl"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^\s*>\s?/.test(l)) { const q = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, '')); out.push('<blockquote>' + inline(q.join(' ')) + '</blockquote>'); continue; }
    const ul = /^\s*[-*•]\s+/, ol = /^\s*\d+[.)]\s+/;
    if (ul.test(l) || ol.test(l)) {
      const ordered = ol.test(l); const items = [];
      while (i < lines.length && (ordered ? ol : ul).test(lines[i])) items.push(inline(lines[i++].replace(ordered ? ol : ul, '')));
      out.push(`<${ordered ? 'ol' : 'ul'}>` + items.map((x) => `<li>${x}</li>`).join('') + `</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const p = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*[-*•]\s|\s*\d+[.)]\s|\s*>)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) p.push(lines[i++]);
    out.push('<p>' + inline(p.join(' ')) + '</p>');
  }
  return out.join('\n');
}
