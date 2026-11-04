// Lender-match underwriting engine.
// Pure functions only (no DOM) so it runs in the browser and in Node tests.
//
// Design principle: this is a SCREENING + RANKING engine, not a decision engine.
//  1. HARD KNOCK-OUTS use only criteria the lender has published (or you supplied).
//  2. CAPACITY is sized like a credit analyst would: FOIR for salaried / DSCR + turnover for business.
//  3. RANKING is a transparent weighted score. Every number is traceable to a check.
//  4. Unknown ≠ pass. Missing criteria lower the confidence and are shown as "unverified".
// Nothing here guarantees an approval: lenders apply private credit policy and live bureau data.

export const DEFAULT_CONFIG = {
  step: 50000,                       // sanction suggestions are rounded DOWN to this step
  // --- Analyst assumptions (editable; lenders do not publish these) ---
  foirCap: { bank: 0.50, nbfc: 0.55, sfb: 0.55, fintech: 0.60 },
  foirLowIncome: 25000, foirLowAdj: -0.05,   // thin-income borrowers get a tighter cap
  foirHighIncome: 100000, foirHighAdj: 0.05, // high-income borrowers get a looser cap
  roiFallback: { bank: 14, nbfc: 18, sfb: 18, fintech: 26 },
  roiFromUplift: 3,                  // when only a "from X%" rate is published, assume X + 3 pts
  cibilDefaultMin: { bank: 700, nbfc: 680, sfb: 680, fintech: 650 }, // used only to scale the CIBIL margin score
  defaultTenure: { PL: 36, BL: 36 },
  minDSCR: 1.25,                     // business loans: (monthly net profit) / (all EMIs) must be >= this
  blTurnoverMultiple: 0.20,          // unsecured BL ticket <= 20% of annual turnover
  blTurnoverMultipleSecured: 0.40,
  blBankCreditsMultiple: 3,          // ticket <= 3 x average monthly bank credits
  maxEnquiries3m: 6,
  memoRate: 18,                      // reference rate for the credit-memo FOIR
  weights: { cibil: 0.25, afford: 0.25, stability: 0.10, ticket: 0.15, price: 0.15, hygiene: 0.10 },
  confidencePenalty: { high: 0, medium: 3, low: 8 },
  lowConfidenceCap: 60,              // a lender we know little about can never outrank verified lenders on score alone
  bands: { strong: 72, possible: 55 },
  calibration: { priorStrength: 8, maxWeight: 0.5, halfSampleN: 20 },
  // Heuristic approval likelihood by band (used ONLY until you have outcome history; replaced by your own rates as data grows)
  bandProb: { Strong: 0.6, Possible: 0.35, Stretch: 0.12 },
  confMult: { high: 1, medium: 0.9, low: 0.7 },
  gstOnFee: 0.18,
  statementFlags: { maxBounces6m: 3, minAbbToCredits: 0.15 },
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const roundDown = (x, step) => Math.floor(x / step) * step;
const roundUp = (x, step) => Math.ceil(x / step) * step;

export function parseMoney(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).toLowerCase().replace(/[₹,\s]|rs\.?|inr/g, '');
  const m = s.match(/^(-?\d+(?:\.\d+)?)(cr|crore|l|lac|lakh|lakhs|k)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2];
  if (!u) return n;
  if (u.startsWith('cr')) return n * 1e7;
  if (u === 'k') return n * 1e3;
  return n * 1e5;
}

export const fmtINR = (n) => {
  if (!isNum(n)) return '–';
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2).replace(/\.?0+$/, '') + ' cr';
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(2).replace(/\.?0+$/, '') + ' L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};

export function emi(p, annualPct, n) {
  const r = annualPct / 1200;
  if (!r) return p / n;
  const g = Math.pow(1 + r, n);
  return (p * r * g) / (g - 1);
}
export function principalFromEmi(e, annualPct, n) {
  if (e <= 0) return 0;
  const r = annualPct / 1200;
  if (!r) return e * n;
  return (e * (1 - Math.pow(1 + r, -n))) / r;
}

// ---------------------------------------------------------------- case normalisation
const bool = (v) => (typeof v === 'boolean' ? v : /^(y|yes|true|1)$/i.test(String(v ?? '').trim()));
const num = (v) => { const m = parseMoney(v); return m === null ? null : m; };
const months = (v) => { // accepts 36, "36", "3 yrs", "18m"
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).toLowerCase().trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(y|yr|yrs|year|years|m|mo|month|months)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] && m[2].startsWith('y') ? n * 12 : n;
};

export function normalizeCase(raw, cfg = DEFAULT_CONFIG) {
  const errors = [], warnings = [];
  const g = (...keys) => { for (const k of keys) if (raw[k] !== undefined && raw[k] !== '') return raw[k]; return undefined; };
  const c = {};
  c.id = String(g('id', 'case_id', 'name', 'customer') ?? '');
  c.product = String(g('product', 'loan_type') ?? '').toUpperCase().replace(/[^A-Z]/g, '').replace('PERSONALLOAN', 'PL').replace('BUSINESSLOAN', 'BL');
  if (!['PL', 'BL'].includes(c.product)) errors.push('product must be PL (personal loan) or BL (business loan)');
  c.purpose = String(g('purpose') ?? '').toLowerCase();
  c.loan_amount = num(g('loan_amount', 'amount', 'loan'));
  if (!isNum(c.loan_amount) || c.loan_amount <= 0) errors.push('loan_amount is required');
  c.tenure_months = months(g('tenure_months', 'tenure')) ?? cfg.defaultTenure[c.product] ?? 36;
  c.age = num(g('age'));
  if (!isNum(c.age) || c.age < 18 || c.age > 80) errors.push('age must be between 18 and 80');
  c.employment = String(g('employment', 'employment_type') ?? (c.product === 'BL' ? 'self_employed' : '')).toLowerCase().replace(/[^a-z]/g, '');
  c.employment = c.employment.startsWith('sal') ? 'salaried' : c.employment.startsWith('self') || c.employment.startsWith('se') || c.employment.startsWith('bus') ? 'self_employed' : c.employment;
  if (c.product === 'PL' && !['salaried', 'self_employed'].includes(c.employment)) errors.push('employment must be salaried or self_employed');
  c.salary_mode = String(g('salary_mode') ?? 'bank').toLowerCase().startsWith('c') ? 'cash' : 'bank';
  c.net_monthly_income = num(g('net_monthly_income', 'monthly_income', 'income'));
  c.existing_emi = num(g('existing_emi', 'existing_emis', 'obligations')) ?? 0;
  const cib = g('cibil', 'bureau_score', 'credit_score');
  c.cibil = cib === undefined || /^(ntc|na|none|new)$/i.test(String(cib)) ? null : num(cib);
  if (c.cibil !== null && (c.cibil < 300 || c.cibil > 900)) errors.push('cibil must be 300–900 (or blank/NTC if no bureau history)');
  const dpd = String(g('worst_dpd_12m', 'dpd') ?? 'none').toLowerCase();
  c.worst_dpd_12m = /90/.test(dpd) ? '90+' : /60/.test(dpd) ? '60' : /30/.test(dpd) ? '30' : 'none';
  c.settled_written_off = bool(g('settled_written_off', 'written_off', 'settled'));
  c.enquiries_3m = num(g('enquiries_3m', 'enquiries')) ?? 0;
  c.current_job_months = months(g('current_job_months', 'current_job'));
  c.total_exp_months = months(g('total_exp_months', 'total_experience'));
  c.business_vintage_months = months(g('business_vintage_months', 'vintage', 'business_vintage'));
  c.annual_turnover = num(g('annual_turnover', 'turnover'));
  c.annual_net_profit = num(g('annual_net_profit', 'net_profit', 'itr_income'));
  c.avg_monthly_bank_credits = num(g('avg_monthly_bank_credits', 'bank_credits'));
  c.collateral = bool(g('collateral', 'collateral_available'));
  c.existing_customer_of = String(g('existing_customer_of') ?? '').split(/[;,|]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  c.city = String(g('city') ?? '');
  c.state = String(g('state') ?? '').trim();
  c.pincode = String(g('pincode', 'pin') ?? '').replace(/\D/g, '');
  c.employer_category = String(g('employer_category', 'employer_cat') ?? '').trim().toUpperCase();
  c.industry = String(g('industry', 'business_type', 'occupation') ?? '').trim().toLowerCase();
  const gstv = g('gst_registered', 'gst');
  c.gst_registered = gstv === undefined ? null : bool(gstv);
  c.itr_years = num(g('itr_years', 'itr_years_filed'));
  c.bank_months_available = num(g('bank_months_available', 'bank_statement_months'));
  c.abb = num(g('abb', 'avg_bank_balance'));
  c.bounces_6m = num(g('bounces_6m', 'bounces'));
  c.residence_type = String(g('residence_type') ?? '').toLowerCase();

  if (c.product === 'PL') {
    if (!isNum(c.net_monthly_income) || c.net_monthly_income <= 0) errors.push('net_monthly_income is required for personal loans (self-employed: average monthly income as per ITR)');
    if (c.employment === 'salaried' && c.current_job_months === null) warnings.push('current_job_months missing – experience checks will show as unverified');
    if (c.employment === 'salaried' && c.total_exp_months === null) warnings.push('total_exp_months missing – experience checks will show as unverified');
    if (c.employment === 'self_employed' && c.business_vintage_months === null) warnings.push('business_vintage_months missing – self-employed vintage checks will show as unverified');
  }
  if (c.product === 'BL') {
    if (c.business_vintage_months === null) errors.push('business_vintage_months is required for business loans');
    if (!isNum(c.annual_turnover)) errors.push('annual_turnover is required for business loans');
    if (!isNum(c.annual_net_profit)) warnings.push('annual_net_profit missing – DSCR check skipped; capacity uses turnover/bank credits only');
    if (!isNum(c.avg_monthly_bank_credits)) warnings.push('avg_monthly_bank_credits missing – banking-based capacity check skipped');
  }
  if (c.cibil === null) warnings.push('No CIBIL score (new-to-credit): lenders with a stated minimum score are excluded');
  return { c, errors, warnings };
}

// ---------------------------------------------------------------- credit memo (borrower-level view)
export function incomeBasis(c) {
  return c.product === 'BL' ? (isNum(c.annual_net_profit) ? c.annual_net_profit / 12 : null) : c.net_monthly_income;
}

export function creditMemo(c, cfg = DEFAULT_CONFIG) {
  const inc = incomeBasis(c);
  const refEmi = emi(c.loan_amount, cfg.memoRate, c.tenure_months);
  const foirExisting = inc ? c.existing_emi / inc : null;
  const foirProposed = inc ? (c.existing_emi + refEmi) / inc : null;
  const dscr = c.product === 'BL' && inc ? inc / (c.existing_emi + refEmi) : null;
  let pts = 0; const drivers = [], flags = [];
  const cib = c.cibil;
  const cp = cib === null ? 12 : cib >= 780 ? 40 : cib >= 750 ? 35 : cib >= 725 ? 30 : cib >= 700 ? 25 : cib >= 675 ? 18 : cib >= 650 ? 12 : 5;
  pts += cp; drivers.push(['Bureau score', cp, 40, cib === null ? 'No bureau history' : String(cib)]);
  const af = foirProposed === null ? 8 : foirProposed <= 0.30 ? 25 : foirProposed <= 0.40 ? 20 : foirProposed <= 0.50 ? 12 : 4;
  pts += af; drivers.push(['Affordability (FOIR at ' + cfg.memoRate + '%)', af, 25, foirProposed === null ? 'n/a' : (foirProposed * 100).toFixed(0) + '%']);
  const stab = c.product === 'BL' ? c.business_vintage_months : (c.employment === 'salaried' ? c.current_job_months : c.business_vintage_months);
  const sp = stab === null || stab === undefined ? 5 : c.product === 'BL' ? (stab >= 60 ? 15 : stab >= 24 ? 10 : 5) : (stab >= 36 ? 15 : stab >= 12 ? 10 : 5);
  pts += sp; drivers.push(['Stability', sp, 15, stab == null ? 'n/a' : stab + ' months']);
  const dp = c.worst_dpd_12m === 'none' ? 15 : c.worst_dpd_12m === '30' ? 8 : c.worst_dpd_12m === '60' ? 3 : 0;
  pts += dp; drivers.push(['Repayment record (12m)', dp, 15, c.worst_dpd_12m === 'none' ? 'Clean' : 'Worst DPD ' + c.worst_dpd_12m]);
  const ep = c.enquiries_3m <= 2 ? 5 : c.enquiries_3m <= 5 ? 3 : 0;
  pts += ep; drivers.push(['Credit hunger (3m enquiries)', ep, 5, String(c.enquiries_3m)]);
  if (c.settled_written_off) { flags.push('Settled / written-off account on bureau – most lenders decline'); pts = Math.min(pts, 34); }
  if (c.worst_dpd_12m === '90+') flags.push('90+ DPD in last 12 months – most lenders decline');
  if (c.worst_dpd_12m === '60') flags.push('60 DPD in last 12 months – prime lenders will likely decline');
  if (c.enquiries_3m > cfg.maxEnquiries3m) flags.push('High enquiry count (' + c.enquiries_3m + ' in 3 months) – looks credit-hungry');
  if (foirProposed !== null && foirProposed > 0.65) flags.push('Proposed obligations exceed 65% of income at the reference rate');
  if (dscr !== null && dscr < cfg.minDSCR) flags.push('DSCR ' + dscr.toFixed(2) + ' is below ' + cfg.minDSCR + ' at the requested amount');
  if (isNum(c.bounces_6m) && c.bounces_6m > cfg.statementFlags.maxBounces6m) flags.push(c.bounces_6m + ' cheque/EMI bounces in the statement window – most lenders probe this');
  if (c.product === 'PL' && c.salary_mode === 'cash' && c.employment === 'salaried') flags.push('Cash salary: no lender in the dataset accepts cash-salaried applicants on published criteria');
  const grade = pts >= 80 ? 'A' : pts >= 65 ? 'B' : pts >= 50 ? 'C' : pts >= 35 ? 'D' : 'E';
  const ltiMonths = inc ? c.loan_amount / inc : null;
  return { grade, points: pts, drivers, flags, metrics: { incomeBasis: inc, refEmi, foirExisting, foirProposed, dscr, ltiMonths } };
}

// ---------------------------------------------------------------- per-lender evaluation
function indicativeRate(P, seg, cfg) {
  if (isNum(P.roi_min) && isNum(P.roi_max)) return { rate: (P.roi_min + P.roi_max) / 2, basis: 'midpoint of published range' };
  if (isNum(P.roi_min)) return { rate: P.roi_min + cfg.roiFromUplift, basis: 'published "from ' + P.roi_min + '%" + ' + cfg.roiFromUplift + ' pts (estimate)' };
  return { rate: cfg.roiFallback[seg] ?? 18, basis: 'segment default (assumption)' };
}
function foirCapFor(seg, income, cfg) {
  let cap = cfg.foirCap[seg] ?? 0.5;
  if (income < cfg.foirLowIncome) cap += cfg.foirLowAdj;
  if (income >= cfg.foirHighIncome) cap += cfg.foirHighAdj;
  return cap;
}
const CRITERIA_FIELDS = {
  PL: ['max_amount', 'min_income', 'min_cibil', 'age_max', 'exp'],
  BL: ['max_amount', 'min_turnover', 'min_cibil', 'age_max', 'min_vintage_months'],
};
function verifiedCount(P, product) {
  const has = (k) => k === 'exp' ? (isNum(P.min_total_exp_months) || isNum(P.min_current_job_months) || isNum(P.min_vintage_months)) :
    k === 'min_cibil' ? (isNum(P.min_cibil) || isNum(P.pref_cibil)) :
    k === 'age_max' ? (isNum(P.age_max) || isNum(P.age_max_salaried) || isNum(P.age_min)) : isNum(P[k]);
  return CRITERIA_FIELDS[product].filter(has).length;
}

// ---------------------------------------------------------------- program model
// A lender's product can define several programs (e.g. salary / ITR / GST / banking / surrogate / secured).
// Flat product criteria are the shared base; each program overrides/adds. No programs => one implicit program.
export function programList(P) {
  const { programs, commercials, ...base } = P;
  if (!Array.isArray(programs) || !programs.length) return [{ id: 'default', name: 'Published criteria', Q: base }];
  return programs.map((pr) => ({ id: pr.id || pr.name, name: pr.name || pr.id, Q: { ...base, ...pr, requires: { ...(base.requires || {}), ...(pr.requires || {}) }, serviceable: { ...(base.serviceable || {}), ...(pr.serviceable || {}) } } }));
}
const norm = (x) => String(x ?? '').trim().toLowerCase();
const inList = (list, v) => (list || []).some((x) => norm(x) === norm(v) || norm(x) === 'pan-india' || norm(x) === 'all');

function serviceCheck(c, Q, L) {
  const s = { ...(L.serviceability || {}), ...(Q.serviceable || {}) };
  const has = s.states || s.cities || s.pincode_prefixes || s.excluded_cities || s.excluded_pincode_prefixes || s.excluded_states;
  if (!has) return null;
  const where = [c.city, c.state, c.pincode].filter(Boolean).join(', ') || 'location not given';
  if (s.excluded_cities && c.city && inList(s.excluded_cities, c.city)) return { status: 'fail', detail: c.city + ' is not serviced' };
  if (s.excluded_states && c.state && inList(s.excluded_states, c.state)) return { status: 'fail', detail: c.state + ' is not serviced' };
  if (s.excluded_pincode_prefixes && c.pincode && s.excluded_pincode_prefixes.some((p) => c.pincode.startsWith(String(p)))) return { status: 'fail', detail: 'Pincode ' + c.pincode + ' is excluded' };
  if (s.pincode_prefixes && c.pincode) return s.pincode_prefixes.some((p) => c.pincode.startsWith(String(p))) ? { status: 'pass', detail: 'Pincode ' + c.pincode + ' serviced' } : { status: 'fail', detail: 'Pincode ' + c.pincode + ' not in serviced list' };
  if (s.states && c.state) return inList(s.states, c.state) ? { status: 'pass', detail: c.state + ' serviced' } : { status: 'fail', detail: c.state + ' not in serviced states' };
  if (s.cities && c.city) return inList(s.cities, c.city) ? { status: 'pass', detail: c.city + ' serviced' } : { status: 'fail', detail: c.city + ' not in serviced cities' };
  return { status: 'unknown', detail: 'Serviceability is restricted but ' + where + ' – confirm with lender' };
}

function parseFee(feeStr, amount, cfg) {
  if (!feeStr || !amount) return null;
  const s = String(feeStr).toLowerCase();
  const gst = /gst|tax/.test(s) ? 1 + cfg.gstOnFee : 1;
  const pct = s.match(/(\d+(?:\.\d+)?)\s*%/g);
  if (pct) { const v = Math.max(...pct.map((x) => parseFloat(x))); return { amount: (amount * v / 100) * gst, basis: v + '%' + (gst > 1 ? ' + GST' : '') + ' (upper bound)' }; }
  const rs = s.replace(/,/g, '').match(/₹\s*(\d+)/);
  if (rs) return { amount: parseFloat(rs[1]) * gst, basis: '₹' + rs[1] + (gst > 1 ? ' + GST' : '') };
  return null;
}

function evalProgram(c, L, P, prog, cfg) {
  const Q = prog.Q;
  const checks = [];
  const add = (id, label, status, detail, hard = true) => checks.push({ id, label, status, detail, hard });
  const seg = L.segment;
  const out = { id: L.id, name: L.name, segment: seg, product: c.product, source: L.source, dataStatus: L.data_status, notes: Q.notes || '', docsNote: Q.docs_note || '', checks, programName: prog.name, programId: prog.id };

  const vc = verifiedCount(Q, c.product);
  out.verifiedFields = vc; out.totalFields = CRITERIA_FIELDS[c.product].length;
  if (vc === 0) { out.status = 'unverified'; out.reasons = ['No usable public criteria – confirm with the lender / Andromeda RM']; return out; }

  // -- access / product rules
  if (Q.existing_customers_only && !c.existing_customer_of.includes(L.id)) add('access', 'Open to this customer', 'fail', 'Offer is only for existing customers of this lender');
  const empAllowed = Q.employment || 'both';
  if (c.product === 'PL' && empAllowed !== 'both' && empAllowed !== c.employment) add('employment', 'Employment type accepted', 'fail', 'Lender takes ' + empAllowed.replace('_', '-') + ' only');
  else if (c.product === 'PL') add('employment', 'Employment type accepted', 'pass', c.employment.replace('_', '-'));
  if (c.product === 'PL' && c.employment === 'salaried' && c.salary_mode === 'cash') add('salary_mode', 'Salary credited to bank', 'fail', 'Cash salary – lenders need bank-credited salary');
  if (Q.secured_only && !c.collateral) add('collateral', 'Collateral available', 'fail', 'Lender page is for a secured loan');
  if (Q.confirm_product) add('product_code', 'Product code confirmed', 'warn', 'Your sheet lists a LAP-style code – confirm unsecured BL is open', false);
  if (Q.location_wise) add('location', 'Location open', 'warn', 'Availability is location-wise per your sheet – confirm for ' + (c.city || 'the customer’s city'), false);
  const sv = serviceCheck(c, Q, L);
  if (sv) add('serviceability', 'Serviceability', sv.status, sv.detail, sv.status === 'fail');

  // -- documents / program gates
  const rq = Q.requires || {};
  if (rq.gst === true) add('gst', 'GST registration', c.gst_registered === null ? 'unknown' : c.gst_registered ? 'pass' : 'fail', c.gst_registered === null ? 'GST status not given' : c.gst_registered ? 'Registered' : 'Program needs GST – customer has none', c.gst_registered === false);
  if (isNum(rq.itr_years) && rq.itr_years > 0) add('itr', 'ITR history', c.itr_years === null ? 'unknown' : c.itr_years >= rq.itr_years ? 'pass' : 'fail', (c.itr_years ?? '?') + ' yrs vs ' + rq.itr_years + ' required', c.itr_years !== null);
  if (isNum(rq.bank_months) && rq.bank_months > 0) add('bank_stmt', 'Bank statement months', c.bank_months_available === null ? 'unknown' : c.bank_months_available >= rq.bank_months ? 'pass' : 'fail', (c.bank_months_available ?? '?') + ' vs ' + rq.bank_months + ' months of statements required', c.bank_months_available !== null);
  if (Array.isArray(Q.negative_industries) && c.industry) {
    const hit = Q.negative_industries.find((n) => c.industry.includes(norm(n)));
    add('industry', 'Industry / occupation', hit ? 'fail' : 'pass', hit ? 'Negative-list industry: ' + hit : c.industry, !!hit);
  }
  if (c.product === 'PL' && c.employment === 'salaried' && Array.isArray(Q.employer_categories) && Q.employer_categories.length) {
    if (!c.employer_category || c.employer_category === 'UNKNOWN') add('employer', 'Employer category', 'unknown', 'Employer category not known; lender accepts ' + Q.employer_categories.join('/'), false);
    else add('employer', 'Employer category', Q.employer_categories.some((x) => norm(x) === norm(c.employer_category)) ? 'pass' : 'fail', c.employer_category + ' vs accepted ' + Q.employer_categories.join('/'));
  }

  // -- age
  const ageMin = c.employment === 'salaried' ? (Q.age_min_salaried ?? Q.age_min) : (Q.age_min_self_employed ?? Q.age_min);
  const ageMax = c.employment === 'salaried' ? (Q.age_max_salaried ?? Q.age_max) : (Q.age_max_self_employed ?? Q.age_max);
  const basis = Q.age_basis || 'unspecified';
  const ageAtMat = c.age + c.tenure_months / 12;
  if (!isNum(ageMin) && !isNum(ageMax)) add('age', 'Age', 'unknown', 'Not published', false);
  else {
    let st = 'pass', d = 'Age ' + c.age + (isNum(ageAtMat) ? ' (at maturity ' + ageAtMat.toFixed(1) + ')' : '');
    if (isNum(ageMin) && c.age < ageMin) { st = 'fail'; d = 'Age ' + c.age + ' < minimum ' + ageMin; }
    else if (isNum(ageMax)) {
      if (basis === 'maturity' && ageAtMat > ageMax) { st = 'fail'; d = 'Age at maturity ' + ageAtMat.toFixed(1) + ' > ' + ageMax; }
      else if (basis !== 'maturity' && c.age > ageMax) { st = 'fail'; d = 'Age ' + c.age + ' > maximum ' + ageMax; }
      else if (basis === 'unspecified' && ageAtMat > ageMax) { st = 'warn'; d = 'Age at maturity ' + ageAtMat.toFixed(1) + ' may exceed ' + ageMax + ' – basis not published'; }
    }
    add('age', 'Age', st, d, st === 'fail');
  }

  // -- bureau (lender-specific; minimum may depend on income slab)
  const cib = c.cibil;
  let minCibil = Q.min_cibil;
  if (c.product === 'PL' && Array.isArray(Q.cibil_by_income) && Q.cibil_by_income.length && isNum(c.net_monthly_income)) {
    const slab = Q.cibil_by_income.filter((r) => c.net_monthly_income >= r.min_income).sort((a, b) => b.min_income - a.min_income)[0];
    if (slab && (!isNum(minCibil) || slab.min_cibil > minCibil)) minCibil = slab.min_cibil;
  }
  if (isNum(minCibil)) {
    if (cib === null) add('cibil', 'Bureau score', 'fail', 'No score; lender needs ≥ ' + minCibil);
    else if (cib < minCibil) add('cibil', 'Bureau score', 'fail', cib + ' < minimum ' + minCibil);
    else add('cibil', 'Bureau score', (isNum(Q.pref_cibil) && cib < Q.pref_cibil) ? 'warn' : 'pass', cib + ' vs minimum ' + minCibil + (isNum(Q.pref_cibil) ? ' (preferred ' + Q.pref_cibil + ')' : ''), false);
  } else if (isNum(Q.pref_cibil)) {
    add('cibil', 'Bureau score', cib === null ? 'warn' : cib < Q.pref_cibil ? 'warn' : 'pass', (cib === null ? 'No score' : cib) + ' vs preferred ' + Q.pref_cibil + ' (no hard minimum published)', false);
  } else add('cibil', 'Bureau score', 'unknown', 'Minimum not published', false);
  const prime = seg === 'bank' || (isNum(minCibil) && minCibil >= 700);
  if (c.settled_written_off) add('bureau_sw', 'Settled / written-off history', 'fail', 'Settled or written-off account on bureau');
  if (c.worst_dpd_12m === '90+') add('dpd', 'Repayment record', 'fail', '90+ DPD in last 12 months');
  else if (c.worst_dpd_12m === '60' && prime) add('dpd', 'Repayment record', 'fail', '60 DPD in last 12 months and lender is prime');
  else if (c.worst_dpd_12m !== 'none') add('dpd', 'Repayment record', 'warn', 'Worst DPD ' + c.worst_dpd_12m + ' in last 12 months', false);
  else add('dpd', 'Repayment record', 'pass', 'Clean for 12 months', false);
  if (isNum(Q.max_enquiries_3m) && c.enquiries_3m > Q.max_enquiries_3m) add('enquiries', 'Bureau enquiries', 'fail', c.enquiries_3m + ' enquiries in 3 months > ' + Q.max_enquiries_3m);
  if (isNum(Q.max_bounces_6m)) add('bounces', 'Bounces (6m)', c.bounces_6m === null ? 'unknown' : c.bounces_6m <= Q.max_bounces_6m ? 'pass' : 'fail', (c.bounces_6m ?? '?') + ' vs max ' + Q.max_bounces_6m, c.bounces_6m !== null && c.bounces_6m > Q.max_bounces_6m);
  else if (isNum(c.bounces_6m) && c.bounces_6m > cfg.statementFlags.maxBounces6m) add('bounces', 'Bounces (6m)', 'warn', c.bounces_6m + ' bounces in statement – expect questions', false);
  if (isNum(Q.min_abb)) add('abb', 'Average bank balance', c.abb === null ? 'unknown' : c.abb >= Q.min_abb ? 'pass' : 'fail', (c.abb === null ? '?' : fmtINR(c.abb)) + ' vs min ' + fmtINR(Q.min_abb), c.abb !== null && c.abb < Q.min_abb);

  // -- income / vintage
  const income = incomeBasis(c);
  if (c.product === 'PL') {
    if (c.employment === 'self_employed' && isNum(Q.min_income_self_employed_annual)) {
      const annual = c.net_monthly_income * 12;
      add('income', 'Income', annual >= Q.min_income_self_employed_annual ? 'pass' : 'fail', fmtINR(annual) + ' p.a. vs minimum ' + fmtINR(Q.min_income_self_employed_annual));
    } else if (isNum(Q.min_income)) {
      add('income', 'Net monthly income', c.net_monthly_income >= Q.min_income ? 'pass' : 'fail', fmtINR(c.net_monthly_income) + ' vs minimum ' + fmtINR(Q.min_income));
    } else add('income', 'Net monthly income', 'unknown', 'Minimum not published', false);
    if (c.employment === 'salaried') {
      if (isNum(Q.min_current_job_months)) add('job', 'Months in current job', c.current_job_months === null ? 'unknown' : c.current_job_months >= Q.min_current_job_months ? 'pass' : 'fail', (c.current_job_months ?? '?') + ' vs minimum ' + Q.min_current_job_months, c.current_job_months !== null);
      if (isNum(Q.min_total_exp_months)) add('exp', 'Total experience (months)', c.total_exp_months === null ? 'unknown' : c.total_exp_months >= Q.min_total_exp_months ? 'pass' : 'fail', (c.total_exp_months ?? '?') + ' vs minimum ' + Q.min_total_exp_months, c.total_exp_months !== null);
    } else if (isNum(Q.min_vintage_months)) {
      add('vintage', 'Business vintage (months)', c.business_vintage_months === null ? 'unknown' : c.business_vintage_months >= Q.min_vintage_months ? 'pass' : 'fail', (c.business_vintage_months ?? '?') + ' vs minimum ' + Q.min_vintage_months, c.business_vintage_months !== null);
    }
  } else {
    if (isNum(Q.min_vintage_months)) add('vintage', 'Business vintage (months)', c.business_vintage_months >= Q.min_vintage_months ? 'pass' : 'fail', c.business_vintage_months + ' vs minimum ' + Q.min_vintage_months);
    else add('vintage', 'Business vintage', 'unknown', 'Not published', false);
    if (isNum(Q.min_turnover)) add('turnover', 'Annual turnover', c.annual_turnover >= Q.min_turnover ? 'pass' : 'fail', fmtINR(c.annual_turnover) + ' vs minimum ' + fmtINR(Q.min_turnover));
    else add('turnover', 'Annual turnover', 'unknown', 'Not published', false);
  }

  // -- capacity (analyst sizing)
  const { rate, basis: rateBasis } = indicativeRate(Q, seg, cfg);
  const n = clamp(c.tenure_months, Q.tenure_min ?? 6, Q.tenure_max ?? 120);
  if (n !== c.tenure_months) out.tenureNote = 'Tenure adjusted to ' + n + ' months to fit lender limits';
  const caps = [];
  let foir = null, dscr = null;
  if (c.product === 'PL') {
    const cap = isNum(Q.foir_cap) ? Q.foir_cap : foirCapFor(seg, income, cfg);
    const maxEmi = cap * income - c.existing_emi;
    caps.push(['FOIR (' + Math.round(cap * 100) + '% cap)', principalFromEmi(maxEmi, rate, n)]);
    foir = (c.existing_emi + emi(c.loan_amount, rate, n)) / income;
    out.foirCap = cap;
  } else {
    if (income !== null) {
      const maxEmi = income / cfg.minDSCR - c.existing_emi;
      caps.push(['DSCR ≥ ' + cfg.minDSCR, principalFromEmi(maxEmi, rate, n)]);
      dscr = income / (c.existing_emi + emi(c.loan_amount, rate, n));
    }
    const tm = isNum(Q.turnover_multiple) ? Q.turnover_multiple : (Q.secured_only && c.collateral ? cfg.blTurnoverMultipleSecured : cfg.blTurnoverMultiple);
    caps.push(['Turnover cap', c.annual_turnover * tm]);
    if (isNum(c.avg_monthly_bank_credits)) caps.push(['Banking cap', c.avg_monthly_bank_credits * cfg.blBankCreditsMultiple]);
  }
  if (isNum(Q.abb_multiple) && isNum(c.abb)) caps.push(['ABB cap', c.abb * Q.abb_multiple]);
  const lenderMax = isNum(Q.max_amount) ? Q.max_amount : Infinity;
  const capacity = Math.max(0, Math.min(...caps.map((x) => x[1])));
  const binding = caps.reduce((a, b) => (a[1] <= b[1] ? a : b));
  const eligible = Math.min(c.loan_amount, lenderMax, capacity);
  const limiter = eligible === c.loan_amount ? 'requested amount' : eligible === lenderMax ? 'lender maximum' : binding[0];
  const suggested = roundDown(eligible, cfg.step);
  const lenderMin = isNum(Q.min_amount) ? Q.min_amount : 0;
  const minStep = Math.max(roundUp(lenderMin, cfg.step), cfg.step);
  if (suggested < minStep && eligible < lenderMin) add('amount', 'Ticket size', 'fail', 'Eligible ' + fmtINR(eligible) + ' is below lender minimum ' + fmtINR(lenderMin) + ' (limited by ' + limiter + ')');
  else if (suggested < minStep) add('amount', 'Ticket size', 'fail', 'Eligible ' + fmtINR(eligible) + ' rounds below the ' + fmtINR(cfg.step) + ' sanction step');
  else add('amount', 'Ticket size', eligible >= c.loan_amount ? 'pass' : 'warn', (eligible >= c.loan_amount ? 'Requested amount fits' : 'Partial: eligible ' + fmtINR(eligible) + ', limited by ' + limiter) + (isNum(Q.max_amount) ? ' (lender max ' + fmtINR(Q.max_amount) + ')' : ''), eligible < lenderMin || suggested < minStep);

  const monthlyEmi = suggested > 0 ? emi(suggested, rate, n) : null;
  const feeEst = parseFee(Q.fee, suggested, cfg);
  Object.assign(out, {
    rate, rateBasis, tenure: n, eligibleAmount: eligible, suggestedAmount: suggested, limiter, requested: c.loan_amount,
    partial: eligible < c.loan_amount, emi: monthlyEmi, foir, dscr,
    totalInterest: monthlyEmi ? monthlyEmi * n - suggested : null, feeEstimate: feeEst ? feeEst.amount : null, feeBasis: feeEst ? feeEst.basis : '',
    totalCostEstimate: monthlyEmi ? monthlyEmi * n - suggested + (feeEst ? feeEst.amount : 0) : null,
    roiRange: isNum(Q.roi_min) ? (isNum(Q.roi_max) ? Q.roi_min + '–' + Q.roi_max + '%' : 'from ' + Q.roi_min + '%') : null,
    fee: Q.fee || '', tatDays: isNum(P.commercials?.tat_days) ? P.commercials.tat_days : null, payoutPct: isNum(P.commercials?.payout_pct) ? P.commercials.payout_pct : null,
  });

  const fails = checks.filter((k) => k.status === 'fail');
  if (fails.length) { out.status = 'excluded'; out.reasons = fails.map((f) => f.label + ': ' + f.detail); return out; }
  out.status = 'eligible';

  const unknowns = checks.filter((k) => k.status === 'unknown').length;
  const ratio = vc / out.totalFields;
  out.confidence = L.data_status === 'third_party' || ratio < 0.4 ? 'low' : ratio >= 0.8 && unknowns === 0 ? 'high' : 'medium';

  const defMin = cfg.cibilDefaultMin[seg] ?? 680;
  const floor = isNum(minCibil) ? minCibil : isNum(Q.pref_cibil) ? Q.pref_cibil : defMin;
  const sCibil = cib === null ? 40 : clamp(40 + ((cib - floor) / 100) * 60, 0, 100);
  let sAfford;
  if (c.product === 'PL') sAfford = clamp(((out.foirCap - foir) / out.foirCap) * 100 + 20, 0, 100);
  else sAfford = dscr === null ? 50 : clamp(((dscr - cfg.minDSCR) / 1.0) * 100 + 40, 0, 100);
  const stab = c.product === 'BL' ? c.business_vintage_months : (c.employment === 'salaried' ? c.current_job_months : c.business_vintage_months);
  const sStab = stab == null ? 40 : clamp((stab / (c.product === 'BL' ? 60 : 36)) * 100, 10, 100);
  const sTicket = clamp((eligible / c.loan_amount) * 100, 0, 100) * (isNum(Q.max_amount) ? (1 - 0.25 * clamp(c.loan_amount / Q.max_amount, 0, 1)) : 0.95);
  const sHyg = (c.worst_dpd_12m === 'none' ? 100 : c.worst_dpd_12m === '30' ? 60 : 25) - (c.enquiries_3m > cfg.maxEnquiries3m ? 25 : c.enquiries_3m > 3 ? 10 : 0) - (isNum(c.bounces_6m) && c.bounces_6m > cfg.statementFlags.maxBounces6m ? 20 : 0);
  out.components = { cibil: sCibil, afford: sAfford, stability: sStab, ticket: sTicket, price: null, hygiene: clamp(sHyg, 0, 100) };

  out.watch = [];
  if (out.partial) out.watch.push('Eligible for ' + fmtINR(suggested) + ' vs ' + fmtINR(c.loan_amount) + ' requested (limited by ' + limiter + ').');
  checks.filter((k) => k.status === 'warn').forEach((k) => out.watch.push(k.label + ': ' + k.detail));
  if (unknowns) out.watch.push(unknowns + (unknowns === 1 ? ' criterion is' : ' criteria are') + ' not published – treat as unverified on that point.');
  if (out.rateBasis.includes('assumption') || out.rateBasis.includes('estimate')) out.watch.push('Rate is indicative (' + out.rateBasis + ').');
  return out;
}

export function evaluateLender(c, L, cfg = DEFAULT_CONFIG) {
  const P = L.products[c.product];
  if (!P) return null;
  const outs = programList(P).map((pr) => evalProgram(c, L, P, pr, cfg));
  const elig = outs.filter((o) => o.status === 'eligible').sort((a, b) => b.eligibleAmount - a.eligibleAmount || a.rate - b.rate);
  let best;
  if (elig.length) best = elig[0];
  else best = outs.filter((o) => o.status === 'excluded').sort((a, b) => a.reasons.length - b.reasons.length)[0] || outs[0];
  best.altPrograms = outs.filter((o) => o !== best).map((o) => ({ name: o.programName, status: o.status, reasons: o.reasons || [] }));
  return best;
}

// ---------------------------------------------------------------- docs
export function documentChecklist(c) {
  const kyc = ['PAN card', 'Aadhaar / passport / voter ID', 'Address proof', 'Recent photograph'];
  if (c.product === 'PL' && c.employment === 'salaried') return [...kyc, 'Last 3 months salary slips', 'Last 3–6 months bank statement showing salary credit', 'Form 16 / appointment or ID card', 'Employer details (email / HR contact)'];
  if (c.product === 'PL') return [...kyc, 'Last 2 years ITR with computation', 'Last 12 months bank statement', 'Business proof (GST / Udyam / shop licence)'];
  return [...kyc, 'Business PAN + incorporation / partnership deed / shop licence', 'Last 2–3 years ITR with CA-audited financials', 'Last 6–12 months primary bank statement', 'GST registration and last 6–12 months returns', 'Udyam / business vintage proof', 'Existing loan statements (if any)'];
}

// ---------------------------------------------------------------- calibration (learn from your own outcomes)
export function cibilBand(x) { return x === null || x === undefined ? 'NTC' : String(Math.floor(x / 50) * 50); }
export function buildCalibration(rows) {
  const m = new Map();
  const bump = (k, ok) => { const v = m.get(k) || { n: 0, ok: 0 }; v.n++; if (ok) v.ok++; m.set(k, v); };
  for (const r of rows) {
    const o = String(r.outcome || '').toLowerCase();
    const ok = /approved|disbursed|sanction/.test(o), bad = /reject|declin|fail/.test(o);
    if (!ok && !bad) continue;
    const prod = String(r.product || '').toUpperCase();
    const lid = String(r.lender_id || '').toLowerCase();
    bump(lid + '|' + prod, ok);
    bump(lid + '|' + prod + '|' + cibilBand(r.cibil === '' || r.cibil == null ? null : Number(r.cibil)), ok);
  }
  return m;
}
export function calibrationFor(cal, lenderId, product, cibil, cfg = DEFAULT_CONFIG) {
  if (!cal || !cal.size) return null;
  const exact = cal.get(lenderId + '|' + product + '|' + cibilBand(cibil));
  const any = cal.get(lenderId + '|' + product);
  const s = exact && exact.n >= 5 ? exact : any;
  if (!s) return null;
  const { priorStrength: k } = cfg.calibration;
  const p = (s.ok + k * 0.5) / (s.n + k);        // Beta-smoothed approval rate with a 50% prior
  const w = Math.min(cfg.calibration.maxWeight, s.n / (s.n + cfg.calibration.halfSampleN));
  return { p, n: s.n, weight: w };
}

// ---------------------------------------------------------------- full run
export function analyse(raw, lenders, cfg = DEFAULT_CONFIG, cal = null, opts = {}) {
  const { c, errors, warnings } = normalizeCase(raw, cfg);
  if (errors.length) return { ok: false, errors, warnings };
  const memo = creditMemo(c, cfg);
  const evals = lenders.map((L) => evaluateLender(c, L, cfg)).filter(Boolean);
  const eligible = evals.filter((e) => e.status === 'eligible');
  const excluded = evals.filter((e) => e.status === 'excluded');
  const unverified = evals.filter((e) => e.status === 'unverified');

  // price score across the eligible set (lower indicative rate is better)
  const rates = eligible.map((e) => e.rate);
  const lo = Math.min(...rates), hi = Math.max(...rates);
  for (const e of eligible) {
    e.components.price = hi === lo ? 70 : clamp(100 * (hi - e.rate) / (hi - lo), 0, 100);
    const w = cfg.weights;
    let score = Object.entries(w).reduce((s, [k, wt]) => s + wt * e.components[k], 0);
    score -= cfg.confidencePenalty[e.confidence];
    if (e.confidence === 'low') score = Math.min(score, cfg.lowConfidenceCap);
    e.baseScore = clamp(score, 0, 100);
    const cl = calibrationFor(cal, e.id, c.product, c.cibil, cfg);
    if (cl) { e.calibration = cl; score = (1 - cl.weight) * score + cl.weight * 100 * cl.p; }
    e.score = clamp(score, 0, 100);
    if (e.confidence === 'low') e.score = Math.min(e.score, cfg.lowConfidenceCap);
    const strongOk = e.score >= cfg.bands.strong && e.confidence !== 'low' && !e.partial;
    e.band = strongOk ? 'Strong' : e.score >= cfg.bands.possible ? 'Possible' : 'Stretch';
  }
  for (const e of eligible) {
    const cl = e.calibration;
    const prior = cfg.bandProb[e.band] * cfg.confMult[e.confidence];
    e.pApprove = cl ? (1 - cl.weight) * prior + cl.weight * cl.p : prior;
    e.pBasis = cl ? 'blend of band prior and your ' + cl.n + ' recorded outcomes' : 'band prior (heuristic – no outcome history yet)';
    e.payout = isNum(e.payoutPct) ? e.suggestedAmount * e.payoutPct / 100 : null;
    e.expectedPayout = e.payout !== null ? e.payout * e.pApprove : null;
  }
  eligible.sort((a, b) => b.score - a.score || a.rate - b.rate);
  eligible.forEach((e, i) => { e.rank = i + 1; });
  const rankedByValue = eligible.some((e) => e.expectedPayout !== null) ? eligible.slice().sort((a, b) => (b.expectedPayout ?? -1) - (a.expectedPayout ?? -1)) : [];
  const cheapest = eligible.filter((e) => e.totalCostEstimate !== null).sort((a, b) => a.totalCostEstimate / a.suggestedAmount - b.totalCostEstimate / b.suggestedAmount).slice(0, 3);
  excluded.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, case: c, warnings, memo, ranked: eligible, rankedByValue, cheapest, excluded, unverified, documents: documentChecklist(c), disclaimer: 'Screening result based on published criteria and analyst assumptions. Not a lender decision or approval guarantee.' };
}
