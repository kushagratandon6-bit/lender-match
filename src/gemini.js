// Google Gemini provider (REST + SSE). Same loop shape as the Anthropic provider.
// Docs: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse
// Auth header: x-goog-api-key. Media goes in as inline_data parts. Tools = function_declarations.
import { createSSEParser, SYSTEM_PROMPT, TOOLS } from './agent-core.js';

export const GEMINI_MODELS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash – latest stable, recommended' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash – stable' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview) – deeper, paid' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash – legacy' },
];
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// JSON-schema -> Gemini schema subset (uppercase types, nullable instead of type unions)
export function toGeminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  let type = s.type;
  if (Array.isArray(type)) { const t = type.find((x) => x !== 'null'); out.nullable = type.includes('null') || undefined; type = t; }
  if (type) out.type = String(type).toUpperCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  if (s.required) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (out.nullable === undefined) delete out.nullable;
  return out;
}
export const GEMINI_TOOLS = [{ function_declarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.input_schema) })) }];

export function userParts(turn) {
  const parts = [];
  for (const a of turn.attachments || []) {
    if (a.kind === 'image') parts.push({ text: `[Attached image: ${a.name}]` }, { inline_data: { mime_type: a.mime || 'image/jpeg', data: a.data } });
    else if (a.kind === 'pdf') parts.push({ text: `[Attached PDF: ${a.name}]` }, { inline_data: { mime_type: 'application/pdf', data: a.data } });
    else parts.push({ text: `[Attached file: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\`` });
  }
  parts.push({ text: turn.text || 'Please assess this case from the attached documents.' });
  return parts;
}

function buildRequest(settings, contents, o = {}) {
  const model = settings.model || GEMINI_MODELS[0].id;
  const payload = {
    system_instruction: { parts: [{ text: o.system || SYSTEM_PROMPT }] },
    contents,
    ...(o.noTools ? {} : { tools: GEMINI_TOOLS }),
    generationConfig: { temperature: o.temperature ?? 0.2, maxOutputTokens: o.maxTokens || 8192, ...(o.json ? { responseMimeType: 'application/json' } : {}) },
  };
  const proxy = (settings.proxyUrl || '').trim();
  const headers = { 'content-type': 'application/json' };
  if (proxy) {
    if (settings.passcode) headers['x-passcode'] = settings.passcode;
    return { url: proxy, init: { method: 'POST', headers, body: JSON.stringify({ provider: 'gemini', model, payload }) } };
  }
  headers['x-goog-api-key'] = (settings.keys && settings.keys.gemini) || '';
  return { url: GEMINI_BASE + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', init: { method: 'POST', headers, body: JSON.stringify(payload) } };
}

async function streamGeminiOnce({ settings, contents, signal, fetchFn = fetch, onText, o }) {
  const { url, init } = buildRequest(settings, contents, o);
  const res = await fetchFn(url, { ...init, signal });
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { const j = await res.json(); msg = j.error?.message || j.message || msg; } catch { /* keep */ }
    const err = new Error(msg); err.status = res.status; throw err;
  }
  const parts = []; let finish = null; let block = null; const usage = {};
  const push = (p) => {
    const plainText = typeof p.text === 'string' && !p.thought && !p.thoughtSignature && !p.thought_signature && !p.functionCall && !p.function_call;
    const last = parts[parts.length - 1];
    if (plainText && last && typeof last.text === 'string' && !last.thought && !last.thoughtSignature && !last.thought_signature) last.text += p.text;
    else parts.push({ ...p });
  };
  const parse = createSSEParser((ev) => {
    if (ev.error) throw new Error(ev.error.message || 'Gemini stream error');
    if (ev.promptFeedback?.blockReason) block = ev.promptFeedback.blockReason;
    if (ev.usageMetadata) Object.assign(usage, ev.usageMetadata);
    const cand = ev.candidates && ev.candidates[0];
    if (!cand) return;
    if (cand.finishReason) finish = cand.finishReason;
    for (const p of (cand.content && cand.content.parts) || []) {
      if (p.thought) continue; // never show thought summaries
      if (typeof p.text === 'string' && p.text === '' && !p.thoughtSignature && !p.thought_signature) continue;
      if (typeof p.text === 'string' && onText && !p.functionCall) onText(p.text);
      push(p);
    }
  });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  for (;;) { const { done, value } = await reader.read(); if (done) break; parse(dec.decode(value, { stream: true })); }
  if (!parts.length) {
    if (block) throw new Error('Gemini blocked the request (' + block + '). Try again or remove the sensitive page.');
    if (finish && finish !== 'STOP') throw new Error('Gemini stopped without an answer (' + finish + ').');
    parts.push({ text: '' });
  }
  return { parts, finish, usage };
}


// ---- resilience: Gemini returns 503 "high demand" / 429 often, and mobile Safari reports dropped connections as "Load failed".
// Retry once on the chosen model, then fall back to other stable models. Never retries after text has started streaming.
export const GEMINI_FALLBACKS = ['gemini-3.5-flash', 'gemini-2.5-flash'];
const isTransient = (e) => [429, 500, 502, 503, 504].includes(e && e.status) || (!(e && e.status) && /load failed|failed to fetch|networkerror|network request failed|terminated/i.test(String((e && e.message) || e)));
const sleep = (ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('Aborted'), { name: 'AbortError' })); }, { once: true }); });
export async function streamGemini(opts) {
  const chosen = (opts.settings && opts.settings.model) || GEMINI_MODELS[0].id;
  const models = [chosen, ...GEMINI_FALLBACKS.filter((m) => m !== chosen)];
  let streamed = false, firstErr = null;
  const onText = opts.onText ? (t) => { streamed = true; opts.onText(t); } : undefined;
  for (let mi = 0; mi < models.length; mi++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await streamGeminiOnce({ ...opts, onText, settings: { ...opts.settings, model: models[mi] } }); }
      catch (e) {
        if (e && e.name === 'AbortError') throw e;
        firstErr = firstErr || e;
        if (streamed || !isTransient(e)) throw (mi === 0 ? e : firstErr);
        if (attempt === 0) await sleep(1500 * (mi + 1), opts.signal);
      }
    }
  }
  throw firstErr;
}

export async function runGemini({ settings, history, turn, executeTool, onText, onToolStart, onToolEnd, signal, fetchFn = fetch, maxLoops = 6 }) {
  const contents = history.slice();
  contents.push({ role: 'user', parts: userParts(turn) });
  for (let i = 0; i < maxLoops; i++) {
    const r = await streamGemini({ settings, contents, signal, fetchFn, onText });
    contents.push({ role: 'model', parts: r.parts });
    const calls = r.parts.filter((p) => p.functionCall || p.function_call);
    if (!calls.length) return { history: contents, usage: r.usage };
    const responses = [];
    for (const p of calls) {
      const fc = p.functionCall || p.function_call;
      const u = { id: fc.name + '-' + i, name: fc.name, input: fc.args || {} };
      onToolStart && onToolStart(u);
      let out;
      try { out = await executeTool(u.name, u.input); onToolEnd && onToolEnd(u, out, false); }
      catch (e) { out = { error: String(e.message || e) }; onToolEnd && onToolEnd(u, out, true); }
      responses.push({ functionResponse: { name: fc.name, response: { result: out } } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  throw new Error('Stopped: too many tool steps');
}

export function geminiFromDisplay(display) {
  const out = [];
  for (const m of display) {
    if (m.role === 'user') {
      const names = (m.files || []).map((f) => f.name);
      out.push({ role: 'user', parts: [{ text: (names.length ? `[Earlier attachments (not re-sent): ${names.join(', ')}]\n` : '') + (m.text || '') }] });
    } else {
      const text = (m.blocks || []).map((b) => b.t === 'text' ? b.text : b.t === 'result' && b.summary ? `[Engine result: ${JSON.stringify(b.summary).slice(0, 6000)}]` : '').filter(Boolean).join('\n');
      if (text) out.push({ role: 'model', parts: [{ text }] });
    }
  }
  return out;
}
