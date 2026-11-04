// Lender data layer: base dataset (src/lenders.json) + the user's local overrides.
// Overrides are what the Model Studio writes (policy-ingested rules, RM-confirmed numbers, payouts/TAT).
// They live only in this browser and can be exported/committed back to lenders.json.
export const OVERRIDE_KEY = 'lender-match.overrides.v1';

export function loadOverrides(storage = globalThis.localStorage) { try { return JSON.parse(storage.getItem(OVERRIDE_KEY) || '{}'); } catch { return {}; } }
export function saveOverrides(o, storage = globalThis.localStorage) { try { storage.setItem(OVERRIDE_KEY, JSON.stringify(o)); return true; } catch { return false; } }

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
// one-level-deep merge of a product spec: top-level keys replaced, `requires`/`commercials`/`serviceable` merged, null deletes
export function mergeProduct(base = {}, patch = {}) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) { delete out[k]; continue; }
    if ((k === 'requires' || k === 'commercials' || k === 'serviceable') && isObj(v) && isObj(base[k])) {
      const m = { ...base[k], ...v };
      for (const kk of Object.keys(m)) if (m[kk] === null) delete m[kk]; // null inside a nested object clears that key
      if (Object.keys(m).length) out[k] = m; else delete out[k];
    } else if (isObj(v)) { const m = { ...v }; for (const kk of Object.keys(m)) if (m[kk] === null) delete m[kk]; if (Object.keys(m).length) out[k] = m; else delete out[k]; }
    else out[k] = v;
  }
  return out;
}
export function mergeLenders(base, overrides = {}) {
  return base.map((L) => {
    const o = overrides[L.id];
    if (!o) return L;
    const products = { ...L.products };
    for (const [p, patch] of Object.entries(o.products || {})) products[p] = o.replace?.[p] ? patch : mergeProduct(products[p], patch);
    return { ...L, products, data_status: o.data_status || L.data_status, source: o.source || L.source, overridden: true, override_meta: o.meta || null };
  });
}
export async function loadLenderData(fetchFn = fetch, url = 'src/lenders.json', storage) {
  const raw = await (await fetchFn(url, { cache: 'no-cache' })).json();
  const ov = loadOverrides(storage);
  return { ...raw, base_lenders: raw.lenders, overrides: ov, lenders: mergeLenders(raw.lenders, ov) };
}

// ------------------------------------------------------------------ validator
const NUM = ['min_amount', 'max_amount', 'roi_min', 'roi_max', 'tenure_min', 'tenure_max', 'age_min', 'age_max', 'age_min_salaried', 'age_max_salaried', 'age_min_self_employed', 'age_max_self_employed', 'min_cibil', 'pref_cibil', 'min_income', 'min_income_self_employed_annual', 'min_turnover', 'min_vintage_months', 'min_current_job_months', 'min_total_exp_months', 'max_enquiries_3m', 'max_bounces_6m', 'min_abb', 'abb_multiple', 'turnover_multiple', 'foir_cap'];
const STR = ['fee', 'notes', 'docs_note', 'age_basis', 'employment'];
const BOOL = ['secured_only', 'existing_customers_only', 'location_wise', 'confirm_product'];
const KNOWN = new Set([...NUM, ...STR, ...BOOL, 'requires', 'programs', 'commercials', 'serviceable', 'employer_categories', 'cibil_by_income', 'negative_industries', 'id', 'name', 'basis']);
const clean = (v) => (v === '' || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? undefined : v);

export function validateProductSpec(spec, product = 'PL') {
  const errors = [], warnings = [], out = {};
  if (!isObj(spec)) return { ok: false, errors: ['Spec must be a JSON object'], warnings, spec: {} };
  for (const [k, raw] of Object.entries(spec)) {
    const v = clean(raw); if (v === undefined || v === null) continue;
    if (NUM.includes(k)) { const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : v; if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) { errors.push(`${k} must be a non-negative number`); continue; } out[k] = n; }
    else if (STR.includes(k)) out[k] = String(v);
    else if (BOOL.includes(k)) out[k] = v === true || v === 'true';
    else if (k === 'requires') { if (!isObj(v)) errors.push('requires must be an object'); else { const r = {}; if (v.gst !== undefined) r.gst = v.gst === true || v.gst === 'true'; for (const x of ['itr_years', 'bank_months']) if (v[x] !== undefined) { const n = Number(v[x]); if (!Number.isFinite(n) || n < 0) errors.push(`requires.${x} must be a number`); else r[x] = n; } out.requires = r; } }
    else if (k === 'commercials') { if (!isObj(v)) errors.push('commercials must be an object'); else { const c = {}; if (v.payout_pct !== undefined && v.payout_pct !== null) { const n = Number(v.payout_pct); if (!Number.isFinite(n) || n < 0 || n > 15) errors.push('commercials.payout_pct must be between 0 and 15'); else c.payout_pct = n; } if (v.tat_days !== undefined && v.tat_days !== null) { const n = Number(v.tat_days); if (!Number.isFinite(n) || n < 0 || n > 90) errors.push('commercials.tat_days must be between 0 and 90'); else c.tat_days = n; } out.commercials = c; } }
    else if (k === 'serviceable') {
      if (!isObj(v)) { errors.push('serviceable must be an object'); continue; }
      const s = {}; for (const f of ['states', 'cities', 'pincode_prefixes', 'excluded_cities', 'excluded_states', 'excluded_pincode_prefixes']) if (v[f] !== undefined) { if (!Array.isArray(v[f]) || v[f].some((x) => typeof x !== 'string')) errors.push(`serviceable.${f} must be a list of text`); else s[f] = v[f].map((x) => x.trim()).filter(Boolean); }
      for (const f of ['pincode_prefixes', 'excluded_pincode_prefixes']) if ((s[f] || []).some((x) => !/^\d{1,6}$/.test(x))) errors.push(`serviceable.${f} must be 1–6 digit prefixes`);
      out.serviceable = s;
    }
    else if (k === 'employer_categories' || k === 'negative_industries') { if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) errors.push(`${k} must be a list of text`); else out[k] = v.map((x) => x.trim().toLowerCase()).filter(Boolean); }
    else if (k === 'cibil_by_income') {
      if (!Array.isArray(v) || v.some((x) => !isObj(x) || !Number.isFinite(Number(x.min_income)) || !Number.isFinite(Number(x.min_cibil)))) errors.push('cibil_by_income must be a list of {min_income, min_cibil}');
      else out[k] = v.map((x) => ({ min_income: Number(x.min_income), min_cibil: Number(x.min_cibil) }));
    }
    else if (k === 'programs') {
      if (!Array.isArray(v)) { errors.push('programs must be a list'); continue; }
      out.programs = []; const ids = new Set();
      v.forEach((p, i) => {
        if (!isObj(p)) { errors.push(`programs[${i}] must be an object`); return; }
        if (!p.id || !p.name) errors.push(`programs[${i}] needs id and name`);
        if (ids.has(p.id)) errors.push(`duplicate program id ${p.id}`); ids.add(p.id);
        const r = validateProductSpec({ ...p, id: undefined, name: undefined, programs: undefined }, product);
        errors.push(...r.errors.map((e) => `programs[${i}].${e}`)); warnings.push(...r.warnings.map((w) => `programs[${i}].${w}`));
        out.programs.push({ id: p.id, name: p.name, ...(p.basis ? { basis: p.basis } : {}), ...r.spec });
      });
    }
    else { warnings.push(`Unknown field "${k}" kept but the engine ignores it`); out[k] = v; }
  }
  if (out.employment !== undefined && !['salaried', 'self_employed', 'both'].includes(out.employment)) errors.push('employment must be salaried, self_employed or both');
  if (out.age_basis !== undefined && !['application', 'maturity', 'unspecified'].includes(out.age_basis)) errors.push('age_basis must be application, maturity or unspecified');
  const pair = (a, b, label) => { if (out[a] !== undefined && out[b] !== undefined && out[a] > out[b]) errors.push(label); };
  pair('min_amount', 'max_amount', 'min_amount is above max_amount'); pair('roi_min', 'roi_max', 'roi_min is above roi_max'); pair('tenure_min', 'tenure_max', 'tenure_min is above tenure_max'); pair('age_min', 'age_max', 'age_min is above age_max');
  if (out.min_cibil !== undefined && (out.min_cibil < 300 || out.min_cibil > 900)) errors.push('min_cibil must be 300–900 (or 0/-1 style "NTC" is not supported – leave blank)');
  if (out.pref_cibil !== undefined && out.min_cibil !== undefined && out.pref_cibil < out.min_cibil) warnings.push('pref_cibil is below min_cibil');
  if (out.max_amount !== undefined && out.max_amount < 10000) warnings.push('max_amount looks too small – amounts are in rupees, not lakhs');
  if (out.min_income !== undefined && out.min_income > 1e6) warnings.push('min_income is monthly rupees – check it is not annual');
  for (const k of ['roi_min', 'roi_max']) if (out[k] !== undefined && (out[k] < 5 || out[k] > 60)) warnings.push(`${k}=${out[k]} is outside the usual 5–60% a year`);
  if (out.foir_cap !== undefined && (out.foir_cap <= 0 || out.foir_cap > 1)) errors.push('foir_cap is a fraction between 0 and 1 (e.g. 0.55)');
  if (out.commercials?.payout_pct > 5) warnings.push('payout above 5% is unusual – check');
  return { ok: errors.length === 0, errors, warnings, spec: out };
}

// Build an override patch (used by Model Studio) and return the new overrides object (pure)
export function withProductPatch(overrides, lenderId, product, patch, meta = {}, opts = {}) {
  const cur = overrides[lenderId] || { products: {} };
  const next = { ...cur, products: { ...cur.products, [product]: opts.replace ? patch : mergeProduct(cur.products?.[product] || {}, patch) }, replace: { ...(cur.replace || {}), ...(opts.replace ? { [product]: true } : {}) }, meta: { ...(cur.meta || {}), ...meta, updated: new Date().toISOString().slice(0, 10) } };
  if (opts.data_status) next.data_status = opts.data_status;
  if (opts.source) next.source = opts.source;
  return { ...overrides, [lenderId]: next };
}
export function removeOverride(overrides, lenderId, product) {
  const o = { ...overrides }; const cur = o[lenderId]; if (!cur) return o;
  if (!product) { delete o[lenderId]; return o; }
  const products = { ...cur.products }; delete products[product];
  if (!Object.keys(products).length) delete o[lenderId]; else o[lenderId] = { ...cur, products };
  return o;
}
// Final lenders.json text with overrides baked in (for committing to GitHub)
export function exportMerged(raw, overrides) {
  const lenders = mergeLenders(raw.lenders, overrides).map(({ overridden, override_meta, ...rest }) => rest);
  return JSON.stringify({ ...raw, lenders, meta: { ...raw.meta, merged_overrides_on: new Date().toISOString().slice(0, 10) } }, null, 2);
}
