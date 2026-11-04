// Browser-only persistence. Nothing here is ever sent anywhere except the API call itself.
const SETTINGS = 'lender-match.settings.v2';
const CHATS = 'lender-match.chats.v1';
const mem = { settings: null };
const DEFAULTS = { provider: 'gemini', model: '', remember: false, proxyUrl: '', passcode: '', keys: { gemini: '', anthropic: '' } };

export function loadSettings() {
  if (mem.settings) return mem.settings;
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS) || '{}'); } catch { /* ignore */ }
  let sk = {};
  try { sk = JSON.parse(sessionStorage.getItem('lender-match.keys') || '{}'); } catch { /* ignore */ }
  const keys = { ...DEFAULTS.keys, ...(s.remember ? s.keys || {} : sk) };
  mem.settings = { ...DEFAULTS, ...s, keys };
  return mem.settings;
}
export function saveSettings(next) {
  mem.settings = { ...loadSettings(), ...next, keys: { ...loadSettings().keys, ...(next.keys || {}) } };
  const { keys, ...rest } = mem.settings;
  try {
    localStorage.setItem(SETTINGS, JSON.stringify(mem.settings.remember ? { ...rest, keys } : rest));
    if (mem.settings.remember) sessionStorage.removeItem('lender-match.keys'); else sessionStorage.setItem('lender-match.keys', JSON.stringify(keys));
  } catch { /* storage blocked */ }
  return mem.settings;
}
export const hasCredentials = (s = loadSettings()) => Boolean((s.proxyUrl || '').trim() || ((s.keys || {})[s.provider] || '').trim());

export function loadChats() { try { return JSON.parse(localStorage.getItem(CHATS) || '[]'); } catch { return []; } }
export function saveChats(chats) {
  const trimmed = chats.slice(0, 40);
  try { localStorage.setItem(CHATS, JSON.stringify(trimmed)); } catch {
    try { localStorage.setItem(CHATS, JSON.stringify(trimmed.slice(0, 10))); } catch { /* give up */ }
  }
}
export function clearChats() { try { localStorage.removeItem(CHATS); } catch { /* ignore */ } }

// ---- outcome log (shared with the manual form UI)
const OUT = 'lender-match.outcomes.v1';
export function loadOutcomes() { try { return JSON.parse(localStorage.getItem(OUT) || '[]'); } catch { return []; } }
export function saveOutcome(o) { const a = loadOutcomes(); a.push(o); try { localStorage.setItem(OUT, JSON.stringify(a)); } catch { /* storage blocked */ } }
