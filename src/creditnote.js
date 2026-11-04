// Printable credit note (self-contained HTML). Open and use Print -> Save as PDF.
import { fmtINR } from './engine.js';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const pct = (x) => (x === null || x === undefined ? '–' : (x * 100).toFixed(0) + '%');

export function creditNoteHTML(r, opts = {}) {
  const c = r.case, m = r.memo, mt = m.metrics;
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const top = r.ranked.slice(0, 6);
  const lenderRows = top.map((e) => `<tr><td>${e.rank}</td><td><b>${esc(e.name)}</b>${e.programName && !['Standard', 'Published criteria'].includes(e.programName) ? `<br><small>${esc(e.programName)}</small>` : ''}</td><td>${esc(e.band)}</td><td>${esc(e.confidence)}</td><td class="n">${fmtINR(e.suggestedAmount)}${e.partial ? '*' : ''}</td><td class="n">${e.emi ? fmtINR(e.emi) : '–'}</td><td>${esc(e.roiRange || 'n/a')}</td><td>${e.tatDays !== null && e.tatDays !== undefined ? e.tatDays + ' d' : '–'}</td><td>${esc((e.watch || []).join('; '))}</td></tr>`).join('');
  const excl = r.excluded.slice(0, 12).map((e) => `<li><b>${esc(e.name)}</b> – ${esc(e.reasons.join('; '))}</li>`).join('');
  const stmt = opts.statement;
  const stmtBlock = stmt ? `<h2>Bank statement analysis</h2><p>${esc(stmt.period.from)} to ${esc(stmt.period.to)} (${stmt.period.months} months) · quality ${esc(stmt.quality.grade)} (${stmt.quality.score}/100)</p><table class="kv"><tr><td>Average genuine monthly credits</td><td class="n">${fmtINR(stmt.avg_monthly_genuine_credits)}</td></tr>${stmt.abb !== null ? `<tr><td>Average bank balance</td><td class="n">${fmtINR(stmt.abb)}</td></tr>` : ''}<tr><td>Existing EMIs detected</td><td class="n">${fmtINR(stmt.existing_emi_monthly)} / month</td></tr><tr><td>Bounces (6 months)</td><td class="n">${stmt.bounces_6m}</td></tr></table>${stmt.flags.length ? `<ul>${stmt.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Credit note ${esc(c.id || '')}</title>
<style>
 body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#1f1e1d;max-width:820px;margin:24px auto;padding:0 18px}
 h1{font-size:20px;margin:0 0 2px} h2{font-size:14px;margin:20px 0 6px;border-bottom:2px solid #C96442;padding-bottom:3px}
 .sub{color:#6b6a68;margin-bottom:14px} table{border-collapse:collapse;width:100%;margin:6px 0} th,td{border:1px solid #ddd;padding:5px 7px;text-align:left;vertical-align:top}
 th{background:#faf9f5} td.n{text-align:right;white-space:nowrap} .kv td:first-child{width:55%;background:#faf9f5}
 .grade{display:inline-block;background:#C96442;color:#fff;border-radius:6px;padding:2px 10px;font-weight:700;font-size:16px;margin-right:8px}
 small{color:#6b6a68} .disc{margin-top:22px;font-size:11px;color:#6b6a68;border-top:1px solid #ddd;padding-top:8px} .print{color:#6b6a68;font-size:11px}
 @media print{.print{display:none} body{margin:0}}
</style></head><body>
<p class="print">Press Ctrl/Cmd + P and choose “Save as PDF”.</p>
<h1>Credit note – ${c.product === 'PL' ? 'Personal loan' : 'Business loan'}</h1>
<div class="sub">Case ${esc(c.id || '–')} · prepared ${esc(date)} · screening against the user's lender panel (data as of ${esc(opts.dataDate || '–')})</div>
<h2>Proposal</h2>
<table class="kv">
<tr><td>Loan requested</td><td class="n">${fmtINR(c.loan_amount)} for ${c.tenure_months} months</td></tr>
<tr><td>Purpose</td><td>${esc(c.purpose || '–')}</td></tr>
<tr><td>Applicant</td><td>${esc(c.employment === 'self_employed' ? 'Self-employed' : 'Salaried')}, age ${esc(c.age)}${c.city ? ', ' + esc(c.city) : ''}${c.state ? ', ' + esc(c.state) : ''}</td></tr>
<tr><td>Bureau</td><td>${c.cibil === null || c.cibil === undefined ? 'No score / not provided' : esc(c.cibil)}${c.worst_dpd_12m && c.worst_dpd_12m !== 'none' ? ' · worst DPD ' + esc(c.worst_dpd_12m) : ''}${c.settled_written_off ? ' · settled/written-off history' : ''}</td></tr>
<tr><td>${c.product === 'BL' ? 'Monthly cash-flow basis' : 'Net monthly income'}</td><td class="n">${fmtINR(mt.incomeBasis)}</td></tr>
<tr><td>FOIR now → with proposed loan</td><td class="n">${pct(mt.foirExisting)} → ${pct(mt.foirProposed)}</td></tr>
${mt.dscr !== null ? `<tr><td>DSCR</td><td class="n">${mt.dscr.toFixed(2)}</td></tr>` : ''}
</table>
<h2>Analyst grade</h2><p><span class="grade">${esc(m.grade)}</span> ${m.points}/100</p>
${m.flags.length ? `<ul>${m.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p>No credit-memo flags.</p>'}
${r.warnings.length ? `<p><i>${r.warnings.map(esc).join('<br>')}</i></p>` : ''}
${stmtBlock}
<h2>Recommended lenders (best fit first)</h2>
${top.length ? `<table><tr><th>#</th><th>Lender / program</th><th>Fit</th><th>Data</th><th>Suggested sanction</th><th>Indicative EMI</th><th>Published rate</th><th>TAT</th><th>Watch-outs</th></tr>${lenderRows}</table><p><small>* partial amount. Sanction rounded down to ₹50,000. EMI uses an indicative rate; the lender decides final terms.</small></p>` : '<p>No lender clears the published criteria for this case.</p>'}
${excl ? `<h2>Not suitable (rule that failed)</h2><ul>${excl}</ul>` : ''}
<h2>Documents to collect</h2>
<ul>${(r.documents || []).map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
<p class="disc">${esc(r.disclaimer)} Bank/NBFC policies are private and change without notice; bureau data is checked live by the lender. Get the customer's written consent before sharing documents with any lender.</p>
</body></html>`;
}
