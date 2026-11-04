// Turn user files into provider-neutral attachments. Images are downscaled in the browser.
import { rowsFromText, analyzeStatement, summaryForModel } from './statement.js';
export const MAX_IMAGE_EDGE = 1800;
export const MAX_PDF_BYTES = 15 * 1024 * 1024; // keeps the whole request under Gemini's ~20 MB inline limit
const b64 = (buf) => { let s = ''; const a = new Uint8Array(buf); const step = 0x8000; for (let i = 0; i < a.length; i += step) s += String.fromCharCode.apply(null, a.subarray(i, i + step)); return btoa(s); };

async function imageToAttachment(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Could not read image ' + file.name)); im.src = url; });
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/jpeg', 0.88).split(',')[1];
    return { kind: 'image', mime: 'image/jpeg', data, preview: c.toDataURL('image/jpeg', 0.45) };
  } finally { URL.revokeObjectURL(url); }
}

export async function fileToAttachment(file) {
  const name = file.name || 'pasted-image';
  const type = file.type || '';
  if (type.startsWith('image/')) return { name, ...(await imageToAttachment(file)) };
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
    if (file.size > MAX_PDF_BYTES) throw new Error(`${name} is larger than ${MAX_PDF_BYTES / 1048576} MB - split it or send fewer pages.`);
    return { name, kind: 'pdf', mime: 'application/pdf', data: b64(await file.arrayBuffer()) };
  }
  if (/^text\//.test(type) || /\.(csv|txt|tsv|json)$/i.test(name)) {
    const raw = await file.text();
    // A bank-statement CSV is analysed on this device; only the computed summary goes to the AI.
    if (/\.(csv|tsv|txt)$/i.test(name) || /^text\/(csv|tab)/.test(type)) {
      const p = rowsFromText(raw);
      if (p.ok && p.rows.length >= 5) {
        const a = analyzeStatement(p.rows, {});
        if (a.ok) return { name, kind: 'text', local: true, analysis: a, text: 'BANK STATEMENT ANALYSED ON THE USER\'S DEVICE (raw transactions were not uploaded). Computed result:\n' + JSON.stringify(summaryForModel(a, name)) };
      }
    }
    return { name, kind: 'text', text: raw.slice(0, 80000) };
  }
  throw new Error(`${name}: unsupported file type. Send a photo, PDF, CSV or text. For Excel, export to PDF/CSV or send a screenshot.`);
}
