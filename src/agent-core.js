// Provider-neutral pieces: system prompt, tool definitions, SSE parsing.
export const SYSTEM_PROMPT = `You are Lender Match, a credit-analyst assistant for an Indian loan DSA. Users upload documents (photos/PDFs of PAN, Aadhaar, bank statements, salary slips, Form 16/ITR, GST, Udyam/Udyam Assist, CIBIL report, shop licence, loan statements) or describe a case for a PERSONAL LOAN (PL, incl. travel loans) or BUSINESS LOAN (BL). You find the best banks/NBFCs from the user's Andromeda lender panel.

Rules of work
1. Read EVERY attached document yourself. First reply with a compact table: Fact | Value | Source doc | Confidence. Mask IDs (PAN/Aadhaar/account numbers: last 4 only). Say plainly what is unreadable or missing. Never guess a number.
2. Extract like an analyst:
   - PAN/Aadhaar: name, DOB (-> age), city/state.
   - Bank statement: if the user attached a CSV it was already analysed on their device - use that result as is. For a PDF/photo statement, transcribe the transactions as lines "dd-mm-yyyy|narration|debit|credit|balance" (leave the amount you cannot read out, never invent) and send them with analyze_statement in chunks of up to ~120 lines, final=true on the last chunk. Do not compute credits, ABB, EMIs or bounces by hand; use the tool result (average genuine monthly credits, ABB, salary pattern, recurring EMIs, bounces, flags). Mention its red flags.
   - Salary slip/offer letter: employer, net salary, joining date (-> months in job); cross-check with bank credits.
   - Form 16/ITR: income, net profit, turnover, years filed. GST: turnover, registration date, filing regularity. No GST is a fact to record, not an error.
   - State, pincode, employer category (govt / PSU / MNC / Listed / Private / Proprietary), industry, ITR years filed, GST status: capture them whenever visible; lenders have program, location and industry rules.
   - Udyam / Udyam Assist / shop act / incorporation: registration date (-> business vintage). Udyam Assist = informal micro enterprise.
   - CIBIL report: score, worst DPD in 12 months, settled/written-off, enquiries in 3 months, live EMIs.
   - Flag mismatches (name/DOB/address, statement gaps, salary on slip vs credits, visible inconsistencies). Present them as items to verify, never as accusations.
3. If loan amount, CIBIL (or confirmation that there is no bureau history) or employment type is missing, ask ONE short question listing all missing must-haves. Otherwise proceed and state your assumptions.
4. When you have enough, call the tool assess_case ONCE with the extracted facts (numbers in rupees; months as numbers; omit unknown fields instead of guessing). The tool runs the lender engine: hard knock-outs on each lender's published criteria, capacity sizing (FOIR for PL; DSCR, turnover and bank-credit caps for BL), ₹50,000-step sanction suggestions, scoring and confidence. Do not do the lender maths yourself and do not invent lender criteria.
5. After the tool returns, reply concisely: (a) one-line verdict, (b) top 5 lenders as a table: Lender | Fit band | Confidence | Suggested sanction | Indicative EMI | Why it fits | Watch-outs, (c) the main exclusions with the exact rule that failed, (d) unverified lenders to ask the RM about, (e) documents still needed and the single next action. If nothing clears the rules, say so and give practical fixes (smaller amount, co-applicant, wait for vintage/bank statements, non-panel route).
6. Be honest: this is screening + ranking, never an approval promise. Lenders use private policy and live bureau data. Unknown is never a pass. Lender data is public-web information dated in the tool result; if the user asks about a lender not covered, say so.
7. Privacy: do not repeat full ID or account numbers. Remind the user that customer consent (DPDP Act) is needed before documents are shared with any lender, once per case.
Style: English, direct, short, execution-first. Use markdown tables for rankings.`;

const num = { type: 'number' };
export const TOOLS = [
  {
    name: 'assess_case',
    description: 'Run the deterministic lender-screening engine on the extracted case facts. Returns the credit memo, ranked eligible lenders (with suggested sanction in ₹50,000 steps), excluded lenders with exact reasons, and unverified lenders. Call once per case after reading all documents.',
    input_schema: {
      type: 'object',
      properties: {
        case_id: { type: 'string', description: 'Customer/case label (no ID numbers)' },
        product: { type: 'string', enum: ['PL', 'BL'] },
        purpose: { type: 'string' },
        loan_amount: { ...num, description: 'Requested amount in rupees' },
        tenure_months: num,
        age: num,
        employment: { type: 'string', enum: ['salaried', 'self_employed'] },
        salary_mode: { type: 'string', enum: ['bank', 'cash'] },
        net_monthly_income: { ...num, description: 'PL: net monthly income (self-employed: average monthly income per ITR/statements)' },
        existing_emi: { ...num, description: 'Total existing EMIs per month' },
        cibil: { type: ['number', 'null'], description: 'Bureau score; null if no history' },
        worst_dpd_12m: { type: 'string', enum: ['none', '30', '60', '90+'] },
        settled_written_off: { type: 'boolean' },
        enquiries_3m: num,
        current_job_months: num,
        total_exp_months: num,
        business_vintage_months: { ...num, description: 'Months since business start (Udyam/GST/registration date)' },
        annual_turnover: num,
        annual_net_profit: { ...num, description: 'Per ITR / financials' },
        avg_monthly_bank_credits: num,
        collateral: { type: 'boolean' },
        gst_registered: { type: 'boolean' },
        city: { type: 'string' },
        state: { type: 'string' },
        pincode: { type: 'string', description: '6-digit residence/business pincode' },
        employer_category: { type: 'string', description: 'govt, psu, mnc, listed, private, proprietary …' },
        industry: { type: 'string' },
        itr_years: { ...num, description: 'Number of years of ITR filed' },
        bank_months_available: { ...num, description: 'Months of bank statement available' },
        abb: { ...num, description: 'Average bank balance (from analyze_statement)' },
        bounces_6m: { ...num, description: 'Cheque/EMI bounces in last 6 months (from analyze_statement)' },
        extraction_notes: { type: 'string', description: 'Short note: key facts, document mismatches, assumptions' },
      },
      required: ['product', 'loan_amount', 'age'],
    },
  },
  {
    name: 'analyze_statement',
    description: 'Deterministic bank-statement analytics for a statement you transcribed from a PDF/photo. Send transactions as lines "dd-mm-yyyy|narration|debit|credit|balance" in chunks; set final=true on the last chunk to get the analysis (genuine credits, ABB, salary, recurring EMIs, bounces, red flags, derived case fields). Not needed for CSV files (already analysed on the device).',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Statement label, e.g. "HDFC Apr-Sep" (no account numbers)' },
        product: { type: 'string', enum: ['PL', 'BL'] },
        rows: { type: 'array', items: { type: 'string' }, description: 'Transaction lines dd-mm-yyyy|narration|debit|credit|balance' },
        final: { type: 'boolean', description: 'true on the last chunk' },
      },
      required: ['rows', 'final'],
    },
  },
  {
    name: 'lookup_lender',
    description: 'Look up the stored public criteria for one lender (e.g. to answer "why not HDFC?" or "what does Kotak need for BL?").',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, product: { type: 'string', enum: ['PL', 'BL'] } }, required: ['name'] },
  },
];

// ---------------------------------------------------------------- SSE parsing
export function createSSEParser(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { onEvent(JSON.parse(data)); } catch { /* ignore malformed */ }
    }
  };
}

