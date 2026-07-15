// Playwright browser smoke for the re-homed Ringside wall (P3 verification).
//
// Confirms the wall behaves when served by the FastAPI app (engine/app.py) rather
// than the old stdlib PersistentHudServer: the page renders, the wall's own data
// fetch (/api/runs) succeeds from the browser, there are zero page/console errors,
// and — if any runs exist on disk — the per-job Expand-all control toggles worker
// detail open. The static wall JS/CSS are served byte-identical (asserted by
// engine_hud_check.sh), so this proves the *serving* re-home, not new frontend.
//
// Playwright is NOT a repo dependency (browsers live outside the venv). Run it
// against a booted app from a directory whose node_modules has playwright:
//
//   set -a; . ~/.config/ringer/engine.env; set +a
//   .venv/bin/uvicorn engine.app:app --host 127.0.0.1 --port 8788 &
//   cp scripts/checks/wall_smoke.mjs /home/ajo/work/playwright-api/ \
//     && node /home/ajo/work/playwright-api/wall_smoke.mjs http://127.0.0.1:8788
//
// Last run 2026-07-15: PASS — 9 expand-all controls, .worker-detail 0->1, 0 errors.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const errors = [];
const netFail = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('requestfailed', r => netFail.push(r.url() + ' ' + (r.failure()?.errorText || '')));

const apiStatus = {};
page.on('response', r => {
  const u = new URL(r.url());
  if (u.pathname === '/api/runs' || u.pathname === '/api/canon' || u.pathname === '/api/models')
    apiStatus[u.pathname] = r.status();
});

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1200); // let pollers fire

const appExists = await page.locator('#kpi-strip').count();
const toggleAll = page.locator('.job-toggle-all');
const nToggles = await toggleAll.count();

let expandResult = 'no runs present → expand-all not exercised (structural parity via byte check)';
if (nToggles > 0) {
  const before = await page.locator('.worker-detail').count();
  await toggleAll.first().click();
  await page.waitForTimeout(800);
  const after = await page.locator('.worker-detail').count();
  expandResult = `expand-all: .worker-detail ${before} -> ${after}`;
  if (after <= before) errors.push(`expand-all did not increase worker-detail (${before}->${after})`);
}

await browser.close();

const problems = [];
if (appExists < 1) problems.push('wall root (#kpi-strip) did not render');
if (apiStatus['/api/runs'] !== 200) problems.push(`/api/runs status ${apiStatus['/api/runs']}`);
// /api/canon + /api/models are only fetched on the models tab (not the runs view),
// so we don't require them here — they're covered by the hud check + live curl.
if (errors.length) problems.push('page/console errors: ' + JSON.stringify(errors));
if (netFail.length) problems.push('failed requests: ' + JSON.stringify(netFail));

console.log('api statuses:', JSON.stringify(apiStatus));
console.log('job-toggle-all controls found:', nToggles);
console.log(expandResult);
if (problems.length) { console.log('FAIL:'); problems.forEach(p => console.log('  - ' + p)); process.exit(1); }
console.log('PASS: wall renders from the re-homed FastAPI app; 0 page errors; data fetches 200');
