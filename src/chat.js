import { analyse, DEFAULT_CONFIG, buildCalibration } from './engine.js';
import { PROVIDERS, runAgent } from './agent.js';
import { renderMarkdown } from './markdown.js';
import { fileToAttachment } from './files.js';
import { addStatementRows, finishStatement, summaryForModel } from './statement.js';
import { loadSettings, saveSettings, hasCredentials, loadChats, saveChats, clearChats, loadOutcomes, saveOutcome } from './store.js';
import { renderAssessment, compactForModel } from './render.js';
import { creditNoteHTML } from './creditnote.js';
import { loadLenderData } from './data.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const uid = () => Math.random().toString(36).slice(2, 10);

let DATA = null;
let chats = loadChats();
let currentId = null;
const apiState = new Map();   // chatId -> { provider, history } (kept in memory only: contains documents)
const previews = new Map();   // chatId -> [per-user-message previews] (memory only)
let pending = [];
let abort = null;
let busy = false;
let lastResult = null;
let lastStatement = null;   // analysis object of the most recent bank statement (memory only)

const cur = () => chats.find((c) => c.id === currentId);

// ------------------------------------------------------------------ boot
async function boot() {
  DATA = await loadLenderData();
  if (!chats.length) newChat(false);
  else selectChat(chats[0].id);
  renderSidebar(); renderThread(); renderChip(); wire();
  if (!hasCredentials()) openSettings('Paste your API key to start.');
}

// ------------------------------------------------------------------ chats
function newChat(render = true) {
  const c = { id: uid(), title: 'New case', updated: Date.now(), display: [] };
  chats.unshift(c); currentId = c.id; pending = []; persist();
  if (render) { renderSidebar(); renderThread(); renderChips(); $('#input').focus(); }
}
function selectChat(id) { currentId = id; pending = []; renderSidebar(); renderThread(); renderChips(); $('#sidebar').classList.remove('open'); }
function persist() { saveChats(chats.map((c) => ({ ...c, display: c.display.map((m) => (m.role === 'user' ? { ...m, files: (m.files || []).map((f) => ({ name: f.name, kind: f.kind })) } : m)) }))); }

function renderSidebar() {
  $('#recents').innerHTML = chats.map((c) => `<div class="rec ${c.id === currentId ? 'on' : ''}" data-id="${c.id}"><span>${esc(c.title)}</span><button data-del="${c.id}" title="Delete">✕</button></div>`).join('');
}
function renderChip() {
  const s = loadSettings(); const p = PROVIDERS[s.provider];
  $('#modelChip').textContent = (s.model || p.defaultModel) + ' ▾';
}

// ------------------------------------------------------------------ rendering
const SUGGESTIONS = [
  'Salaried PL – I will upload 3 salary slips + 6 months bank statement',
  'Business loan – Udyam, ITR, GST and bank statement coming up',
  'Paste case details (age, income, CIBIL, amount) and rank lenders',
];
function renderThread() {
  const c = cur(); const th = $('#thread');
  if (!c || !c.display.length) {
    th.innerHTML = `<div class="empty"><svg class="spark" viewBox="0 0 32 32"><path d="M16 4v24M4 16h24M7.5 7.5l17 17M24.5 7.5l-17 17" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>
      <h1>Which case are we screening?</h1><p>Drop the customer's documents – PAN, bank statements, salary slips, ITR, GST, Udyam, CIBIL – and get a ranked list of the best banks and NBFCs from your Andromeda panel.</p>
      <div class="sugg">${SUGGESTIONS.map((s) => `<button data-sugg="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
    return;
  }
  th.innerHTML = c.display.map((m, i) => messageHTML(m, i === c.display.length - 1 && busy)).join('');
  th.scrollTop = th.scrollHeight;
}
function userHTML(m, idx) {
  const pv = (previews.get(currentId) || {})[idx] || [];
  const files = (m.files || []).map((f, k) => `<div class="file">${pv[k] ? `<img src="${pv[k]}" alt="">` : '📄'}<span>${esc(f.name)}</span></div>`).join('');
  return `<div class="msg user">${files ? `<div class="files">${files}</div>` : ''}${m.text ? `<div class="bubble">${esc(m.text)}</div>` : ''}</div>`;
}
function messageHTML(m, live) {
  if (m.role === 'user') return userHTML(m, cur().display.indexOf(m));
  const body = (m.blocks || []).map((b, i, arr) => {
    if (b.t === 'text') return `<div class="md">${renderMarkdown(b.text)}${live && i === arr.length - 1 ? '<span class="typing"></span>' : ''}</div>`;
    if (b.t === 'step') return `<div class="step ${b.err ? 'err' : b.done ? 'done' : ''}"><span class="dot"></span>${esc(b.label)}</div>`;
    if (b.t === 'result') return renderAssessment(b.result);
    if (b.t === 'error') return `<div class="err">${esc(b.text)}</div>`;
    return '';
  }).join('');
  return `<div class="msg assistant">${body || (live ? '<div class="step"><span class="dot"></span>Reading…</div>' : '')}</div>`;
}
let raf = 0;
function refreshLast() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0; const th = $('#thread'); const c = cur(); if (!c) return;
    const near = th.scrollHeight - th.scrollTop - th.clientHeight < 140;
    const msgs = th.querySelectorAll('.msg');
    const last = c.display[c.display.length - 1];
    const html = messageHTML(last, busy);
    if (last.role === 'assistant' && msgs.length) msgs[msgs.length - 1].outerHTML = html; else th.insertAdjacentHTML('beforeend', html);
    if (near) th.scrollTop = th.scrollHeight;
  });
}

// ------------------------------------------------------------------ tools (deterministic engine)
function executeTool(name, input) {
  if (name === 'assess_case') {
    const useCal = true;
    const outs = loadOutcomes();
    const cal = useCal && outs.length ? buildCalibration(outs) : null;
    const r = analyse(input, DATA.lenders, DEFAULT_CONFIG, cal);
    if (!r.ok) return { status: 'needs_more_info', errors: r.errors, warnings: r.warnings };
    lastResult = r;
    return compactForModel(r, DATA.meta.collected_on);
  }
  if (name === 'analyze_statement') {
    const label = input.label || 'statement';
    const add = addStatementRows(label, Array.isArray(input.rows) ? input.rows : []);
    if (!input.final) return { status: 'chunk_received', ...add, next: 'send the remaining lines, final=true on the last chunk' };
    const a = finishStatement(label, { product: input.product || 'PL' });
    if (a.ok) lastStatement = a;
    return summaryForModel(a, label);
  }
  if (name === 'lookup_lender') {
    const q = String(input.name || '').toLowerCase();
    const hits = DATA.lenders.filter((l) => l.name.toLowerCase().includes(q) || l.id.includes(q.replace(/\s+/g, '_')) || l.sheet_names.some((s) => s.toLowerCase().includes(q)));
    if (!hits.length) return { found: false, note: 'Not on the user\'s PL/BL panel list in this dataset' };
    return { found: true, data_collected_on: DATA.meta.collected_on, lenders: hits.map((l) => ({ name: l.name, type: l.segment, data_status: l.data_status, source: l.source, products: input.product ? { [input.product]: l.products[input.product] || null } : l.products })) };
  }
  throw new Error('Unknown tool ' + name);
}
const stepLabel = (u) => (u.name === 'assess_case' ? 'Screening the case against your lender panel…' : u.name === 'analyze_statement' ? 'Analysing the bank statement…' : 'Looking up lender criteria…');

// ------------------------------------------------------------------ send
async function send() {
  if (busy) { abort && abort.abort(); return; }
  const input = $('#input'); const text = input.value.trim();
  if (!text && !pending.length) return;
  if (!hasCredentials()) { openSettings('Add your API key to continue.'); return; }
  const c = cur(); const settings = loadSettings(); const provider = PROVIDERS[settings.provider];
  const files = pending.slice(); pending = []; input.value = ''; autosize(); renderChips();
  const stmtFile = files.find((f) => f.analysis); if (stmtFile) lastStatement = stmtFile.analysis;

  const idx = c.display.length;
  const pv = previews.get(c.id) || {}; pv[idx] = files.map((f) => f.preview || null); previews.set(c.id, pv);
  c.display.push({ role: 'user', text, files: files.map((f) => ({ name: f.name, kind: f.kind })) });
  if (c.title === 'New case') c.title = (text || files[0]?.name || 'New case').replace(/\s+/g, ' ').slice(0, 42);
  const asst = { role: 'assistant', blocks: [] }; c.display.push(asst);
  busy = true; setSend(); renderSidebar(); renderThread();

  let st = apiState.get(c.id);
  if (!st || st.provider !== settings.provider) st = { provider: settings.provider, history: provider.fromDisplay(c.display.slice(0, idx)) };
  abort = new AbortController();
  const appendText = (d) => { const l = asst.blocks[asst.blocks.length - 1]; if (l && l.t === 'text') l.text += d; else asst.blocks.push({ t: 'text', text: d }); refreshLast(); };
  try {
    const out = await runAgent({
      settings: { ...settings, model: settings.model || provider.defaultModel },
      history: st.history, turn: { text, attachments: files }, executeTool, signal: abort.signal,
      onText: appendText,
      onToolStart: (u) => { asst.blocks.push({ t: 'step', id: u.id, label: stepLabel(u), done: false }); refreshLast(); },
      onToolEnd: (u, o, isErr) => {
        const s = asst.blocks.find((b) => b.t === 'step' && b.id === u.id); if (s) { s.done = true; s.err = isErr; }
        if (u.name === 'assess_case' && o && o.status === 'ok' && lastResult) asst.blocks.push({ t: 'result', result: lastResult, summary: o });
        refreshLast();
      },
    });
    apiState.set(c.id, { provider: settings.provider, history: out.history });
  } catch (e) {
    if (e.name === 'AbortError') asst.blocks.push({ t: 'text', text: '*Stopped.*' });
    else asst.blocks.push({ t: 'error', text: friendlyError(e, settings) });
  } finally {
    busy = false; abort = null; c.updated = Date.now(); chats.sort((a, b) => b.updated - a.updated); persist(); setSend(); renderSidebar(); renderThread();
  }
}
function friendlyError(e, s) {
  const m = String(e.message || e);
  if (/API key|API_KEY|invalid|401|403|permission/i.test(m) && !/blocked/i.test(m)) return m + '\n\nCheck the API key in Settings (and that the Generative Language API is enabled for the project).';
  if (/429|quota|rate/i.test(m)) return m + '\n\nRate limit hit. Wait a minute, or use a billing-enabled key / lighter model.';
  if (/Failed to fetch|NetworkError|CORS/i.test(m)) return 'Network/CORS error calling the AI provider: ' + m + '\n\nIf this persists, set up the optional proxy (see README) or check your connection.';
  return m;
}
function setSend() { const b = $('#sendBtn'); b.textContent = busy ? '■' : '↑'; b.classList.toggle('stop', busy); b.setAttribute('aria-label', busy ? 'Stop' : 'Send'); }

// ------------------------------------------------------------------ attachments
function renderChips() {
  $('#chips').innerHTML = pending.map((f, i) => `<div class="chip">${f.preview ? `<img src="${f.preview}" alt="">` : '📄'}<span>${esc(f.name)}</span><button data-rm="${i}" aria-label="Remove">✕</button></div>`).join('');
}
async function addFiles(list) {
  for (const f of [...list]) {
    try { pending.push(await fileToAttachment(f)); }
    catch (e) { const c = cur(); c.display.push({ role: 'assistant', blocks: [{ t: 'error', text: String(e.message || e) }] }); renderThread(); }
  }
  renderChips();
}
function autosize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 220) + 'px'; }

// ------------------------------------------------------------------ settings dialog
function fillSettingsUI() {
  const s = loadSettings(); const p = PROVIDERS[s.provider];
  $('#setProvider').innerHTML = Object.values(PROVIDERS).map((x) => `<option value="${x.id}" ${x.id === s.provider ? 'selected' : ''}>${x.label}</option>`).join('');
  $('#setKey').value = (s.keys || {})[s.provider] || '';
  $('#setKey').placeholder = p.keyPlaceholder;
  $('#keyHelp').innerHTML = `<a href="${p.keyUrl}" target="_blank" rel="noopener noreferrer">get a key</a>`;
  $('#setRemember').checked = !!s.remember;
  $('#setModel').value = s.model || p.defaultModel;
  $('#modelList').innerHTML = p.models.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
  $('#setProxy').value = s.proxyUrl || ''; $('#setPass').value = s.passcode || '';
  $('#privacyWarn').innerHTML = s.provider === 'gemini'
    ? '<b>Customer documents contain personal data.</b> On Google\'s free tier, prompts may be used to improve Google products and reviewed by humans. Use a key from a <b>billing-enabled (paid) project</b> for real cases, and get customer consent. The key stays in this browser unless you set a proxy.'
    : '<b>Customer documents contain personal data.</b> They are sent to the provider you choose. Get customer consent first. The key stays in this browser unless you set a proxy.';
}
function openSettings(msg = '') { fillSettingsUI(); $('#settingsMsg').textContent = msg; $('#settings').showModal(); }

// ------------------------------------------------------------------ wiring
function wire() {
  $('#newChat').addEventListener('click', () => newChat());
  $('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#openSettings').addEventListener('click', () => openSettings());
  $('#modelChip').addEventListener('click', () => openSettings());
  $('#clearHistory').addEventListener('click', () => { if (confirm('Delete all saved chats from this browser? (Outcome log is kept.)')) { clearChats(); chats = []; apiState.clear(); previews.clear(); newChat(); } });
  $('#recents').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]'); if (del) { e.stopPropagation(); chats = chats.filter((c) => c.id !== del.dataset.del); apiState.delete(del.dataset.del); if (!chats.length) newChat(false); if (currentId === del.dataset.del) currentId = chats[0].id; persist(); renderSidebar(); renderThread(); return; }
    const r = e.target.closest('.rec'); if (r) selectChat(r.dataset.id);
  });
  $('#thread').addEventListener('click', (e) => {
    const sg = e.target.closest('[data-sugg]'); if (sg) { $('#input').value = sg.dataset.sugg; autosize(); $('#input').focus(); return; }
    const tb = e.target.closest('.rc-tabs button');
    if (tb) { const rc = tb.closest('.rc'); rc.querySelectorAll('.rc-tabs button').forEach((b) => b.classList.toggle('on', b === tb)); rc.querySelectorAll('.rc-view').forEach((v) => { v.hidden = !v.classList.contains('v-' + tb.dataset.view); }); return; }
    const cn = e.target.closest('.cnote');
    if (cn) {
      const idx = [...$('#thread').children].indexOf(cn.closest('.msg'));
      const blk = (cur().display[idx]?.blocks || []).find((b) => b.t === 'result');
      const res = (blk && blk.result) || lastResult; if (!res) return;
      const w = window.open(URL.createObjectURL(new Blob([creditNoteHTML(res, { dataDate: DATA.meta.collected_on, statement: lastStatement })], { type: 'text/html' })), '_blank');
      if (!w) alert('Allow pop-ups to open the credit note.');
      return;
    }
    const sv = e.target.closest('.saveOut');
    if (sv) {
      const sel = sv.parentElement.querySelector('select'); if (!sel.value) return;
      let cs = {}; try { cs = JSON.parse(sv.closest('.rc').dataset.case || '{}'); } catch { /* ignore */ }
      saveOutcome({ date: new Date().toISOString().slice(0, 10), case_id: cs.case_id || '', product: cs.product, lender_id: sv.dataset.id, lender: sv.dataset.name, cibil: cs.cibil, amount: cs.amount, income_or_turnover: cs.income_or_turnover, snapshot: cs.snap, outcome: sel.value });
      sv.textContent = 'Saved ✓';
    }
  });
  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  input.addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });
  $('#sendBtn').addEventListener('click', send);
  $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#chips').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { pending.splice(Number(b.dataset.rm), 1); renderChips(); } });
  let dragDepth = 0; const dz = $('#dropzone');
  addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; dz.classList.add('on'); } });
  addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dz.classList.remove('on'); });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; dz.classList.remove('on'); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
  $('#setProvider').addEventListener('change', (e) => { saveSettings({ provider: e.target.value, model: '' }); fillSettingsUI(); });
  $('#cancelSettings').addEventListener('click', () => $('#settings').close('cancel'));
  $('#settings').addEventListener('close', () => {
    if ($('#settings').returnValue !== 'save') return;
    const s = loadSettings(); const prov = $('#setProvider').value;
    saveSettings({ provider: prov, model: $('#setModel').value.trim(), remember: $('#setRemember').checked, proxyUrl: $('#setProxy').value.trim(), passcode: $('#setPass').value, keys: { ...s.keys, [prov]: $('#setKey').value.trim() } });
    renderChip();
  });
}

boot().catch((e) => { $('#thread').innerHTML = `<div class="err" style="max-width:700px;margin:40px auto">Failed to start: ${esc(e.message)}</div>`; });
