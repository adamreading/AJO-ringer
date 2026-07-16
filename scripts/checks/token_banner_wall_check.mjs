// Browser check: the per-JOB token-burn badge renders in the Ringside wall job
// header (banner space beside Job title / rounds / Expand-all), and SUMS the
// per-round feeder_totals across every round of the job.
//
// Deterministic: intercepts /api/runs at the browser and returns a synthetic
// two-round job carrying feeder_totals, so it proves the render + the cross-round
// sum without depending on an enriched run existing on disk. Asserts 0 page errors.
//
// Playwright is NOT a repo dependency. Run against the live HUD from a dir whose
// node_modules has playwright:
//   cp scripts/checks/token_banner_wall_check.mjs /home/ajo/work/playwright-api/ \
//     && node /home/ajo/work/playwright-api/token_banner_wall_check.mjs http://127.0.0.1:8700
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8700';
const errors = [];

// Two rounds of ONE job (same run_name) → the badge must show the SUM.
//   r1: total 31,591  in 31,032  out 559   calls 11
//   r2: total 10,000  in  9,000  out 1,000 calls 4
//   sum: total 41,591 in 40,032  out 1,559 calls 15
const mockRuns = {
  active: {},
  runs: [
    {
      run_name: 'token-badge-demo', started_at: '2026-07-16T08:00:00Z', state: 'done',
      tasks: [{ name: 'a', status: 'pass' }],
      feeder_totals: { total_tokens: 31591, input_tokens: 31032, output_tokens: 559, calls: 11 },
    },
    {
      run_name: 'token-badge-demo', started_at: '2026-07-16T09:00:00Z', state: 'done',
      tasks: [{ name: 'b', status: 'pass' }],
      feeder_totals: { total_tokens: 10000, input_tokens: 9000, output_tokens: 1000, calls: 4 },
    },
  ],
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

// Intercept the wall's data fetch and hand back the synthetic job.
await page.route('**/api/runs', route =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockRuns) }));

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1200); // let the 1s poller fire with the mocked payload

const nBadges = await page.locator('.job-tokens').count();
const totalText = (await page.locator('.job-tokens-total').first().textContent().catch(() => '')) || '';
const splitText = (await page.locator('.job-tokens-split').first().textContent().catch(() => '')) || '';

await browser.close();

const problems = [];
if (nBadges < 1) problems.push('no .job-tokens badge rendered in the job header');
if (!totalText.includes('41,591')) problems.push(`summed total wrong (want 41,591): "${totalText}"`);
if (!totalText.includes('tok')) problems.push(`total missing 'tok' unit: "${totalText}"`);
if (!splitText.includes('40,032 in')) problems.push(`input sum wrong (want 40,032 in): "${splitText}"`);
if (!splitText.includes('1,559 out')) problems.push(`output sum wrong (want 1,559 out): "${splitText}"`);
if (!splitText.includes('15 calls')) problems.push(`calls sum wrong (want 15 calls): "${splitText}"`);
if (errors.length) problems.push('page errors: ' + errors.join(' | '));

if (problems.length) {
  console.error('FAIL:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
console.log(`PASS: job token badge renders + sums across rounds — "${totalText}" · "${splitText}", 0 page errors`);
