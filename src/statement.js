// Bank-statement analytics. Pure functions. Turns transactions into the facts a credit analyst
// reads off a statement: genuine credits, ABB, salary pattern, EMIs, bounces, red flags.
import { parseRows } from './csv.js';

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export function parseDate(v) {
  if (v instanceof Date) return v;
  const s = String(v ?? '').trim(); let m;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if ((m = s.match(/^(\d{1,2})[-/\s.]([A-Za-z]{3,9})[-/\s.,]*(\d{2,4})/))) { const mo = MON[m[2].slice(0, 3).toLowerCase()]; let y = +m[3]; if (y < 100) y += 2000; return mo === undefined ? null : new Date(Date.UTC(y, mo, +m[1])); }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) { let y = +m[3]; if (y < 100) y += 2000; return new Date(Date.UTC(y, +m[2] - 1, +m[1])); } // Indian dd/mm/yyyy
  return null;
}
const toNum = (v) => { if (v === null || v === undefined || v === '') return null; const s = String(v).replace(/[,₹\s]/g, '').replace(/^\((.*)\)$/, '-$1').replace(/(cr|dr)$/i, ''); const x = parseFloat(s); return Number.isFinite(x) ? x : null; };
const monthKey = (d) => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

const RX = {
  self: /(\bSELF\b|OWN\s*A\/?C|TRF\s*TO\s*SELF|TRANSFER TO SELF|SELF TRANSFER|OWN ACCOUNT)/i,
  loanCredit: /(DISBURS|LOAN\s*(CR|CREDIT|AMT)|CASHE|KREDITBEE|KRAZYBEE|MONEYVIEW|FIBE|EARLYSALARY|NAVI|LAZYPAY|SLICE|PAYSENSE|MPOCKET|STASHFIN|KISSHT|ZESTMONEY|FINNABLE|HOME CREDIT|PAYME INDIA|TRUBALANCE|PRECIOUS|FATAKPAY|MONEYTAP|FREO)/i,
  reversal: /(REVERSAL|\bREV\b|REFUND|CHARGEBACK|REJECT|FAILED TXN)/i,
  cashDep: /(CASH\s*DEP|\bCDM\b|BY CASH|CASH DEPOSIT|CASH-DEP|CSH DEP)/i,
  salary: /(SALARY|\bSAL\b|PAYROLL|SAL CREDIT|SALARY CR|WAGES)/i,
  emi: /(\bEMI\b|\bNACH\b|\bECS\b|ACH\s*D\b|LN\s*REPAY|LOAN REPAY|LOAN A\/C|LOAN INSTALMENT|BAJAJ FIN|TATA CAP|HDB FIN|MUTHOOT|HERO FIN|CHOLA|L&T FIN|IDFC FIRST.*LOAN|FULLERTON|SMFG|POONAWALLA|ADITYA BIRLA FIN|CREDILA|CARS24 FIN)/i,
  bounce: /(CHQ\s*RET|CHEQUE\s*RET|CHQ RTN|ECS\s*RET|NACH\s*RET|ACH\s*RETURN|BOUNCE|INSUFF|DISHON|UNPAID|RTN CHG|RETURN CHG|OW RTN|I\/W RTN)/i,
  gaming: /(DREAM11|\bMPL\b|RUMMY|\bBETTING\b|\bBET365\b|CASINO|LOTTERY|FANTASY|POKER|1XBET|PARIMATCH|WINZO|MY11CIRCLE|HOWZAT|GAMES24X7|\bA23\b|JUNGLEE|LUDO|TEEN PATTI)/i,
};

// ---- parse a bank-export CSV/TSV into rows. Finds the header row even if the file has a preamble.
export function rowsFromText(text) {
  const raw = parseRows(text);
  const find = (cells, rx) => cells.findIndex((c) => rx.test(String(c).trim().toLowerCase()));
  let hi = -1, cols = null;
  for (let i = 0; i < Math.min(raw.length, 40); i++) {
    const cells = raw[i].map((c) => String(c).trim().toLowerCase());
    const d = find(cells, /date/), n = find(cells, /narration|description|particulars|remarks|details|transaction/);
    const dr = find(cells, /withdraw|debit|\bdr\b|paid out/), cr = find(cells, /deposit|credit|\bcr\b|paid in/), am = find(cells, /^amount|txn amount|transaction amount/);
    if (d >= 0 && (n >= 0 || dr >= 0 || am >= 0) && (dr >= 0 || cr >= 0 || am >= 0)) { hi = i; cols = { d, n, dr, cr, am, ty: find(cells, /^(type|dr\/cr|cr\/dr|drcr)$/), bal: find(cells, /balance/) }; break; }
  }
  if (hi < 0) return { ok: false, error: 'Could not find date / debit / credit columns' };
  const rows = [];
  for (const r of raw.slice(hi + 1)) {
    const date = parseDate(r[cols.d]); if (!date) continue;
    let debit = cols.dr >= 0 ? toNum(r[cols.dr]) : null, credit = cols.cr >= 0 ? toNum(r[cols.cr]) : null;
    if (cols.am >= 0 && debit === null && credit === null) {
      const a = toNum(r[cols.am]); const ty = cols.ty >= 0 ? String(r[cols.ty]).toLowerCase() : '';
      if (a !== null) { if (/dr|debit|w/.test(ty) || a < 0) debit = Math.abs(a); else credit = Math.abs(a); }
    }
    if (!debit && !credit) continue;
    rows.push({ date, desc: cols.n >= 0 ? String(r[cols.n]) : '', debit: debit || 0, credit: credit || 0, balance: cols.bal >= 0 ? toNum(r[cols.bal]) : null });
  }
  return rows.length ? { ok: true, rows } : { ok: false, error: 'No transactions parsed' };
}
// "dd-mm-yyyy|narration|debit|credit|balance" lines (used when the AI reads a PDF/photo statement)
export function rowsFromLines(lines) {
  const rows = [];
  for (const ln of lines) {
    const p = String(ln).split('|'); const date = parseDate(p[0]); if (!date) continue;
    const debit = toNum(p[2]) || 0, credit = toNum(p[3]) || 0; if (!debit && !credit) continue;
    rows.push({ date, desc: String(p[1] ?? ''), debit, credit, balance: toNum(p[4]) });
  }
  return rows;
}

// ---- the analytics
export function analyzeStatement(input, opts = {}) {
  const product = opts.product || 'PL';
  const rows = input.filter((r) => r.date).slice().sort((a, b) => a.date - b.date);
  if (!rows.length) return { ok: false, error: 'No transactions' };
  const first = rows[0].date, last = rows[rows.length - 1].date;
  const mk = new Set(rows.map((r) => monthKey(r.date)));
  const months = [...mk].sort();
  const byMonth = Object.fromEntries(months.map((m) => [m, { month: m, credits: 0, genuine: 0, debits: 0, n: 0, closing: null, minBal: null }]));
  let totCred = 0, genuine = 0, cash = 0, loanCred = 0, loanN = 0, selfCred = 0, revCred = 0, gamingN = 0, gamingAmt = 0, bounceRows = [], gamingRows = [];
  const emiDebits = []; const salCands = []; const genuineCredits = [];
  for (const r of rows) {
    const m = byMonth[monthKey(r.date)]; m.n++;
    const d = (r.desc || '').toUpperCase();
    if (r.balance !== null) { m.closing = r.balance; m.minBal = m.minBal === null ? r.balance : Math.min(m.minBal, r.balance); }
    if (r.credit) {
      totCred += r.credit; m.credits += r.credit;
      if (RX.self.test(d)) selfCred += r.credit;
      else if (RX.loanCredit.test(d) && !RX.salary.test(d)) { loanCred += r.credit; loanN++; }
      else if (RX.reversal.test(d)) revCred += r.credit;
      else { genuine += r.credit; m.genuine += r.credit; genuineCredits.push(r); if (RX.cashDep.test(d)) cash += r.credit; if (RX.salary.test(d)) salCands.push(r); }
    }
    if (r.debit) {
      m.debits += r.debit;
      if (RX.emi.test(d) && !RX.bounce.test(d)) emiDebits.push(r);
      if (RX.bounce.test(d) && !RX.reversal.test(d)) bounceRows.push(r);
      if (RX.gaming.test(d)) { gamingN++; gamingAmt += r.debit; gamingRows.push(r); }
    }
  }
  const nMonths = months.length;
  const avgGenuine = genuine / nMonths;
  // average bank balance (daily, carried forward) when a balance column exists
  const withBal = rows.filter((r) => r.balance !== null);
  let abb = null, minBal = null, negDays = 0;
  if (withBal.length >= rows.length * 0.8) {
    const byDay = new Map(); for (const r of withBal) byDay.set(r.date.getTime(), r.balance);
    let cur = withBal[0].balance, sum = 0, days = 0; minBal = Infinity;
    for (let t = first.getTime(); t <= last.getTime(); t += 86400000) { if (byDay.has(t)) cur = byDay.get(t); sum += cur; days++; if (cur < minBal) minBal = cur; if (cur < 0) negDays++; }
    abb = sum / days;
  }
  // salary pattern: regex-tagged, else recurring largest credit with stable amount & day
  let salary = null;
  const sMonths = {}; for (const r of salCands) { const k = monthKey(r.date); if (!sMonths[k] || r.credit > sMonths[k].credit) sMonths[k] = r; }
  let sPick = Object.values(sMonths), sConf = sPick.length >= 3 ? 'high' : 'medium';
  if (sPick.length < 2) {
    const big = {}; for (const r of genuineCredits) { const k = monthKey(r.date); if (!big[k] || r.credit > big[k].credit) big[k] = r; }
    const arr = Object.values(big);
    const med = median(arr.map((x) => x.credit));
    const stable = arr.filter((x) => med && Math.abs(x.credit - med) / med <= 0.15);
    const days = stable.map((x) => x.date.getUTCDate());
    if (arr.length >= 3 && stable.length >= Math.max(3, Math.ceil(arr.length * 0.7)) && Math.max(...days) - Math.min(...days) <= 7) { sPick = stable; sConf = 'medium'; } else sPick = [];
  }
  if (sPick.length >= 2) salary = { monthly: median(sPick.slice(-3).map((x) => x.credit)), months: sPick.length, typicalDay: Math.round(median(sPick.map((x) => x.date.getUTCDate()))), confidence: sConf };
  // recurring EMIs: same amount (±2%) in >= 2 distinct months
  const groups = [];
  for (const r of emiDebits) { const g = groups.find((x) => Math.abs(x.amt - r.debit) / x.amt <= 0.02); if (g) { g.months.add(monthKey(r.date)); g.n++; } else groups.push({ amt: r.debit, months: new Set([monthKey(r.date)]), n: 1, desc: r.desc }); }
  const recurring = groups.filter((g) => g.months.size >= 2);
  const emiMonthly = recurring.reduce((s, g) => s + g.amt, 0);
  // bounces in the last 6 months of the statement
  const cutoff = last.getTime() - 183 * 86400000;
  const bounces6 = bounceRows.filter((r) => r.date.getTime() >= cutoff).length;
  // round-tripping: same large amount out and in within 3 days
  let roundTrips = 0; const credBig = rows.filter((r) => r.credit >= 10000);
  for (const dr of rows.filter((r) => r.debit >= 10000)) if (credBig.some((c) => Math.abs(c.credit - dr.debit) < 1 && Math.abs(c.date - dr.date) <= 3 * 86400000 && c !== dr)) roundTrips++;
  roundTrips = Math.floor(roundTrips / 2) || (roundTrips ? 1 : 0);
  const top3 = genuineCredits.slice().sort((a, b) => b.credit - a.credit).slice(0, 3).reduce((s, r) => s + r.credit, 0);

  const flags = [], sev = [];
  const needMonths = product === 'BL' ? 6 : 3;
  if (nMonths < needMonths) { flags.push(`Only ${nMonths} month(s) of statement; lenders usually want ${needMonths}+`); sev.push(15); }
  if (bounces6 > 0) { flags.push(`${bounces6} cheque/EMI bounce(s) in last 6 months`); sev.push(bounces6 > 3 ? 30 : 12); }
  if (gamingN) { flags.push(`${gamingN} betting/gaming transaction(s) worth ₹${Math.round(gamingAmt).toLocaleString('en-IN')}`); sev.push(25); }
  if (loanN >= 2) { flags.push(`${loanN} instant-loan / loan-app credits – dependence on short-term credit`); sev.push(15); }
  if (totCred && cash / totCred > 0.4) { flags.push('Cash deposits are ' + Math.round((cash / totCred) * 100) + '% of credits'); sev.push(12); }
  if (genuine && top3 / genuine > 0.6 && genuineCredits.length > 6) { flags.push('Top 3 credits are ' + Math.round((top3 / genuine) * 100) + '% of income – concentrated inflows'); sev.push(8); }
  if (roundTrips >= 3) { flags.push(`${roundTrips} possible round-trip pairs (same amount in and out within 3 days)`); sev.push(20); }
  if (abb !== null && avgGenuine && abb < avgGenuine * 0.15) { flags.push('Average balance is very low versus monthly credits'); sev.push(8); }
  if (negDays) { flags.push(`Balance negative on ${negDays} day(s)`); sev.push(10); }
  if (product === 'PL' && !salary) { flags.push('No regular salary pattern detected'); sev.push(10); }
  const score = Math.max(0, 100 - sev.reduce((a, b) => a + b, 0));
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D';
  const monthly = months.map((k) => { const m = byMonth[k]; return { month: k, credits: Math.round(m.credits), genuine_credits: Math.round(m.genuine), debits: Math.round(m.debits), txns: m.n, closing_balance: m.closing }; });
  return {
    ok: true, period: { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10), months: nMonths, transactions: rows.length },
    totals: { credits: Math.round(totCred), genuine_credits: Math.round(genuine), excluded_self_transfers: Math.round(selfCred), excluded_loan_credits: Math.round(loanCred), excluded_reversals: Math.round(revCred), cash_deposits: Math.round(cash) },
    avg_monthly_genuine_credits: Math.round(avgGenuine), abb: abb === null ? null : Math.round(abb), min_balance: minBal === null ? null : Math.round(minBal),
    salary, recurring_emis: recurring.map((g) => ({ amount: Math.round(g.amt), months: g.months.size, sample: String(g.desc).slice(0, 40) })), existing_emi_monthly: Math.round(emiMonthly),
    bounces_6m: bounces6, gaming: { count: gamingN, amount: Math.round(gamingAmt) }, loan_app_credits: loanN, round_trip_pairs: roundTrips,
    flags, quality: { score, grade }, monthly,
    derived_case_fields: { net_monthly_income: salary ? Math.round(salary.monthly) : undefined, existing_emi: Math.round(emiMonthly), avg_monthly_bank_credits: Math.round(avgGenuine), abb: abb === null ? undefined : Math.round(abb), bounces_6m: bounces6, bank_months_available: nMonths },
  };
}

// Convenience: raw CSV text -> analysis (or {ok:false})
export function analyzeStatementText(text, opts) {
  const p = rowsFromText(text);
  if (!p.ok) return p;
  return analyzeStatement(p.rows, opts);
}

// Accumulator for AI-supplied rows (PDF/photo statements read by the model in chunks)
const store = new Map();
export function addStatementRows(label, lines) {
  const k = label || 'statement'; const cur = store.get(k) || [];
  const rows = rowsFromLines(lines); store.set(k, cur.concat(rows));
  return { label: k, rows_added: rows.length, rows_rejected: lines.length - rows.length, total_rows: store.get(k).length };
}
export function finishStatement(label, opts) { const k = label || 'statement'; const rows = store.get(k) || []; store.delete(k); return analyzeStatement(rows, opts); }
export function resetStatements() { store.clear(); }

// Compact, privacy-safe summary for the LLM (no narrations, no account numbers)
export function summaryForModel(a, label) {
  if (!a || !a.ok) return { status: 'error', error: (a && a.error) || 'No analysis' };
  return {
    status: 'ok', statement: label || 'statement', period: a.period, quality: a.quality,
    avg_monthly_genuine_credits: a.avg_monthly_genuine_credits, abb: a.abb, min_balance: a.min_balance,
    totals: a.totals, salary: a.salary, recurring_emis: a.recurring_emis, existing_emi_monthly: a.existing_emi_monthly,
    bounces_6m: a.bounces_6m, gaming: a.gaming, loan_app_credits: a.loan_app_credits, round_trip_pairs: a.round_trip_pairs,
    flags: a.flags, monthly: a.monthly, derived_case_fields: a.derived_case_fields,
    note: 'Computed locally by deterministic rules from the statement. Pass derived_case_fields into assess_case; for BL use avg_monthly_genuine_credits as avg_monthly_bank_credits.',
  };
}
