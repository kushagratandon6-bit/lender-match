// Provider registry + Anthropic provider. Gemini lives in gemini.js (default provider).
import { createSSEParser, SYSTEM_PROMPT, TOOLS } from './agent-core.js';
import { GEMINI_MODELS, runGemini, geminiFromDisplay, streamGemini, userParts } from './gemini.js';
export { SYSTEM_PROMPT, TOOLS, createSSEParser };

export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 – fast, recommended' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5 – deeper, slower' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 – cheapest' },
];

function anthropicBlocks(turn) {
  const blocks = [];
  for (const a of turn.attachments || []) {
    if (a.kind === 'image') blocks.push({ type: 'text', text: `[Attached image: ${a.name}]` }, { type: 'image', source: { type: 'base64', media_type: a.mime || 'image/jpeg', data: a.data } });
    else if (a.kind === 'pdf') blocks.push({ type: 'text', text: `[Attached PDF: ${a.name}]` }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
    else blocks.push({ type: 'text', text: `[Attached file: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\`` });
  }
  blocks.push({ type: 'text', text: turn.text || 'Please assess this case from the attached documents.' });
  return blocks;
}

function anthropicRequest(settings, messages, o = {}) {
  const model = settings.model || ANTHROPIC_MODELS[0].id;
  const payload = { model, max_tokens: o.maxTokens || 4096, stream: true, system: o.system || SYSTEM_PROMPT, ...(o.noTools ? {} : { tools: TOOLS }), messages };
  const proxy = (settings.proxyUrl || '').trim();
  const headers = { 'content-type': 'application/json' };
  if (proxy) { if (settings.passcode) headers['x-passcode'] = settings.passcode; return { url: proxy, init: { method: 'POST', headers, body: JSON.stringify({ provider: 'anthropic', model, payload }) } }; }
  headers['x-api-key'] = (settings.keys && settings.keys.anthropic) || '';
  headers['anthropic-version'] = '2023-06-01';
  headers['anthropic-dangerous-direct-browser-access'] = 'true';
  return { url: ANTHROPIC_ENDPOINT, init: { method: 'POST', headers, body: JSON.stringify(payload) } };
}

export async function streamAnthropic({ settings, messages, signal, fetchFn = fetch, onText, o }) {
  const { url, init } = anthropicRequest(settings, messages, o);
  const res = await fetchFn(url, { ...init, signal });
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { const j = await res.json(); msg = j.error?.message || j.message || msg; } catch { /* keep */ }
    const err = new Error(msg); err.status = res.status; throw err;
  }
  const blocks = []; let stop = null; const usage = {};
  const parse = createSSEParser((ev) => {
    if (ev.type === 'message_start') Object.assign(usage, ev.message?.usage || {});
    else if (ev.type === 'content_block_start') blocks[ev.index] = { ...ev.content_block, _json: '' };
    else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index]; if (!b) return;
      if (ev.delta.type === 'text_delta') { b.text = (b.text || '') + ev.delta.text; onText && onText(ev.delta.text); }
      else if (ev.delta.type === 'input_json_delta') b._json += ev.delta.partial_json;
    } else if (ev.type === 'message_delta') { stop = ev.delta?.stop_reason || stop; Object.assign(usage, ev.usage || {}); }
    else if (ev.type === 'error') throw new Error(ev.error?.message || 'stream error');
  });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  for (;;) { const { done, value } = await reader.read(); if (done) break; parse(dec.decode(value, { stream: true })); }
  const content = blocks.filter(Boolean).map((b) => {
    if (b.type === 'tool_use') { let input = {}; try { input = b._json ? JSON.parse(b._json) : {}; } catch { input = {}; } return { type: 'tool_use', id: b.id, name: b.name, input }; }
    if (b.type === 'text') return { type: 'text', text: b.text || '' };
    return null;
  }).filter(Boolean);
  return { content, stop_reason: stop, usage };
}

export async function runAnthropic({ settings, history, turn, executeTool, onText, onToolStart, onToolEnd, signal, fetchFn = fetch, maxLoops = 6 }) {
  const messages = history.slice();
  messages.push({ role: 'user', content: anthropicBlocks(turn) });
  for (let i = 0; i < maxLoops; i++) {
    const r = await streamAnthropic({ settings, messages, signal, fetchFn, onText });
    messages.push({ role: 'assistant', content: r.content.length ? r.content : [{ type: 'text', text: '' }] });
    const uses = r.content.filter((b) => b.type === 'tool_use');
    if (r.stop_reason !== 'tool_use' || !uses.length) return { history: messages, usage: r.usage };
    const results = [];
    for (const u of uses) {
      onToolStart && onToolStart(u);
      let out, isError = false;
      try { out = await executeTool(u.name, u.input); } catch (e) { out = { error: String(e.message || e) }; isError = true; }
      onToolEnd && onToolEnd(u, out, isError);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out), ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error('Stopped: too many tool steps');
}

function anthropicFromDisplay(display) {
  const out = [];
  for (const m of display) {
    if (m.role === 'user') {
      const names = (m.files || []).map((f) => f.name);
      out.push({ role: 'user', content: [{ type: 'text', text: (names.length ? `[Earlier attachments (not re-sent): ${names.join(', ')}]\n` : '') + (m.text || '') }] });
    } else {
      const text = (m.blocks || []).map((b) => b.t === 'text' ? b.text : b.t === 'result' && b.summary ? `[Engine result: ${JSON.stringify(b.summary).slice(0, 6000)}]` : '').filter(Boolean).join('\n');
      if (text) out.push({ role: 'assistant', content: [{ type: 'text', text }] });
    }
  }
  return out;
}

export const PROVIDERS = {
  gemini: {
    id: 'gemini', label: 'Google Gemini', models: GEMINI_MODELS, defaultModel: GEMINI_MODELS[0].id,
    keyUrl: 'https://aistudio.google.com/apikey', keyPlaceholder: 'AIza…', run: runGemini, fromDisplay: geminiFromDisplay,
  },
  anthropic: {
    id: 'anthropic', label: 'Anthropic Claude', models: ANTHROPIC_MODELS, defaultModel: ANTHROPIC_MODELS[0].id,
    keyUrl: 'https://console.anthropic.com/settings/keys', keyPlaceholder: 'sk-ant-…', run: runAnthropic, fromDisplay: anthropicFromDisplay,
  },
};

// Unified entry point used by the UI and tests.
export function runAgent(opts) {
  const p = PROVIDERS[opts.settings.provider || 'gemini'];
  return p.run(opts);
}

// One-shot completion with a custom system prompt and no tools (policy extraction etc.)
export async function completeText({ settings, system, attachments = [], text, json = false, maxTokens = 8192, signal, fetchFn = fetch, onText }) {
  const provider = settings.provider || 'gemini';
  const o = { system, noTools: true, json, maxTokens, temperature: 0 };
  if (provider === 'gemini') {
    const model = settings.model || GEMINI_MODELS[0].id;
    const r = await streamGemini({ settings: { ...settings, model }, contents: [{ role: 'user', parts: userParts({ attachments, text }) }], signal, fetchFn, onText, o });
    return r.parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  }
  const model = settings.model || ANTHROPIC_MODELS[0].id;
  const r = await streamAnthropic({ settings: { ...settings, model }, messages: [{ role: 'user', content: anthropicBlocks({ attachments, text }) }], signal, fetchFn, onText, o });
  return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}
