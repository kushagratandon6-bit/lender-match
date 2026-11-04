// Renders an engine assessment as a compact, Claude-styled result card.
import { fmtINR, DEFAULT_CONFIG } from './engine.js';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const pct = (x) => (x === null || x === undefined ? '–' : (x * 100).toFixed(0) + '%');

export function renderAssessment(r) {
  const m = r.memo, c = r.case, mt = m.metrics;
  const head = `<div class="rc-head">
    <div class="rc-grade g-${m.grade}"><b>${m.grade}</b><span>${m.points}/100</span></div>
    <div class="rc-metrics">
      <div><b>${fmtINR(c.loan_amount)}</b><span>${c.product === 'PL' ? 'Personal' : 'Business'} loan · ${c.tenure_months} mo</span></div>
      <div><b>${fmtINR(mt.incomeBasis)}</b><span>${c.product === 'BL' ? 'Monthly cash flow' : 'Net monthly income'}</span></div>
      <div><b>${pct(mt.foirExisting)} → ${pct(mt.foirProposed)}</b><span>FOIR now → with loan</span></div>
      ${mt.dscr !== null ? `<div><b>${mt.dscr.toFixed(2)}</b><span>DSCR (min ${DEFAULT_CONFIG.minDSCR})</span></div>` : ''}
    </div></div>`;
  const flags = m.flags.length ? `<ul class="rc-flags">${m.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '';
  const warn = r.warnings.length ? `<p class="rc-warn">${r.warnings.map(esc).join('<br>')}</p>` : '';
  const row = (e, label, amountText) => `<details class="rc-l">
      <summary><span class="rk">${label}</span><span class="nm">${esc(e.name)}${e.programName && !['Standard', 'Published criteria'].includes(e.programName) ? `<small class="pg">${esc(e.programName)}</small>` : ''}</span><span class="bd b-${e.band}">${e.band}</span><span class="cf">${e.confidence} data</span><span class="am">${amountText}</span><span class="sc">${e.score.toFixed(0)}</span></summary>
      <div class="rc-body">
        <div class="rc-nums"><span>Sanction <b>${fmtINR(e.suggestedAmount)}${e.partial ? ' (partial)' : ''}</b></span><span>EMI <b>${e.emi ? fmtINR(e.emi) : '–'}</b> · ${e.tenure} mo @ ${e.rate.toFixed(1)}%</span><span>Published rate <b>${esc(e.roiRange || 'n/a')}</b></span><span>${e.foir !== null ? 'FOIR <b>' + pct(e.foir) + '</b>' : e.dscr !== null ? 'DSCR <b>' + e.dscr.toFixed(2) + '</b>' : ''}</span>${e.fee ? `<span>Fee <b>${esc(e.fee)}</b></span>` : ''}${e.totalCostEstimate ? `<span>Interest + fees <b>${fmtINR(e.totalCostEstimate)}</b></span>` : ''}${e.tatDays !== null && e.tatDays !== undefined ? `<span>TAT <b>${e.tatDays} d</b></span>` : ''}${e.pApprove !== undefined ? `<span>Approval odds <b>~${Math.round(e.pApprove * 100)}%</b> <small>(${esc(e.pBasis)})</small></span>` : ''}${e.payout !== null && e.payout !== undefined ? `<span>Payout <b>${fmtINR(e.payout)}</b> (exp. ${fmtINR(e.expectedPayout)})</span>` : ''}</div>
        ${e.altPrograms && e.altPrograms.length ? `<p class="rc-mut">Other programs: ${e.altPrograms.map((a) => esc(a.name + (a.eligible ? ' (eligible)' : ' – ' + (a.reason || 'not eligible')))).join(' · ')}</p>` : ''}
        ${e.watch.length ? `<p class="rc-warn">${e.watch.map(esc).join('<br>')}</p>` : ''}
        <ul class="rc-chk">${e.checks.map((k) => `<li class="s-${k.status}"><b>${esc(k.label)}</b> – ${esc(k.detail)}</li>`).join('')}</ul>
        ${e.notes ? `<p class="rc-mut">${esc(e.notes)}</p>` : ''}
        ${e.source ? `<p class="rc-mut">Source: <a href="${esc(e.source)}" target="_blank" rel="noopener noreferrer">${esc(e.source)}</a></p>` : ''}
        <div class="rc-out"><span class="rc-mut">Outcome</span><select><option value="">–</option><option value="approved">Approved</option><option value="disbursed">Disbursed</option><option value="rejected">Rejected</option><option value="dropped">Dropped</option></select><button class="saveOut" data-id="${esc(e.id)}" data-name="${esc(e.name)}">Save</button></div>
      </div></details>`;
  const none = '<p class="rc-warn">No lender clears the published criteria for this case.</p>';
  const fit = r.ranked.length ? r.ranked.map((e) => row(e, e.rank, fmtINR(e.suggestedAmount) + (e.partial ? ' (partial)' : ''))).join('') : none;
  const hasValue = r.rankedByValue && r.rankedByValue.some((e) => e.expectedPayout !== null && e.expectedPayout !== undefined);
  const val = hasValue ? r.rankedByValue.map((e, i) => row(e, i + 1, e.expectedPayout !== null ? '~' + fmtINR(e.expectedPayout) : '–')).join('') : '';
  const cost = r.cheapest && r.cheapest.length ? r.cheapest.map((e, i) => row(e, i + 1, fmtINR(e.totalCostEstimate))).join('') : '';
  const tabs = hasValue || cost ? `<div class="rc-tabs" role="tablist"><button data-view="fit" class="on">Best for customer</button>${hasValue ? '<button data-view="value">Best for you (expected payout)</button>' : ''}${cost ? '<button data-view="cost">Cheapest</button>' : ''}</div>` : '';
  const list = `${tabs}<div class="rc-view v-fit">${fit}</div>${hasValue ? `<div class="rc-view v-value" hidden><p class="rc-mut">Expected payout = payout % × suggested sanction × approval odds. Use it to choose between lenders that are all acceptable for the customer – never to push a weak fit.</p>${val}</div>` : ''}${cost ? `<div class="rc-view v-cost" hidden><p class="rc-mut">Lowest total interest + fees over the tenure at the indicative rate.</p>${cost}</div>` : ''}`;
  const excl = r.excluded.length ? `<details class="rc-x"><summary>Excluded (${r.excluded.length})</summary>${r.excluded.map((e) => `<p><b>${esc(e.name)}</b> – ${esc(e.reasons.join('; '))}</p>`).join('')}</details>` : '';
  const unv = r.unverified.length ? `<details class="rc-x"><summary>Unverified – no public criteria (${r.unverified.length})</summary><p>${r.unverified.map((e) => esc(e.name)).join(', ')}</p></details>` : '';
  const caseData = esc(JSON.stringify({ product: c.product, cibil: c.cibil ?? '', amount: c.loan_amount, income_or_turnover: c.product === 'BL' ? c.annual_turnover : c.net_monthly_income, case_id: c.id, snap: c }));
  return `<div class="rc" data-case="${caseData}"><div class="rc-title">Lender screening${c.id ? ' · ' + esc(c.id) : ''}</div>${head}${flags}${warn}<div class="rc-list">${list}</div><div class="rc-actions"><button class="cnote">Credit note ↗</button></div>${excl}${unv}<p class="rc-mut">${esc(r.disclaimer)}</p></div>`;
}

export function compactForModel(r, collectedOn) {
  return {
    status: 'ok', lender_data_collected_on: collectedOn,
    credit_memo: { grade: r.memo.grade, points: r.memo.points, flags: r.memo.flags, metrics: { monthly_income_basis: r.memo.metrics.incomeBasis, foir_existing: r.memo.metrics.foirExisting, foir_with_new_loan_at_18pct: r.memo.metrics.foirProposed, dscr: r.memo.metrics.dscr } },
    warnings: r.warnings,
    ranked_lenders: r.ranked.slice(0, 8).map((e) => ({ rank: e.rank, lender: e.name, type: e.segment, band: e.band, confidence: e.confidence, score: Math.round(e.score), suggested_sanction_rupees: e.suggestedAmount, partial: e.partial, limited_by: e.limiter, indicative_emi: e.emi ? Math.round(e.emi) : null, rate_used_pct: Number(e.rate.toFixed(2)), rate_basis: e.rateBasis, published_rate: e.roiRange, fee: e.fee, watch: e.watch, notes: e.notes })),
    eligible_count: r.ranked.length,
    excluded: r.excluded.map((e) => ({ lender: e.name, reasons: e.reasons })),
    unverified_no_public_criteria: r.unverified.map((e) => e.name),
    documents_to_collect: r.documents,
    note: r.disclaimer,
  };
}
