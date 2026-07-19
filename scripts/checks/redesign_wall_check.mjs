// Browser check: the Claude Design redesign of the Ringside wall.
//
// Proves, against route-mocked API data (deterministic, no disk deps):
//   §1 three-level progressive disclosure (job → rounds → worker table → detail
//      tabs BRIEF/ACTIONS/OUTPUT), all collapsed on load, expand-all toggle
//   §2 job chip strip filters the jobs list (bottom bar gone)
//   §3 FEED + ARTIFACTS slide-over drawers
//   §4 KPI strip: tokens in/out sub, passed split bar
//   §5 matrix rain: h4-only, dim, intensity slider present
//   §6 SCORE column renders the orchestrator grade (0..1 → /10, green ≥7)
//   §8 models page: wire-class chips + ranked scoreboard + footnote
//   §9 queue kanban columns with per-column accents
//   §10 theme designer: segmented base, swatches, rain slider persistence
//   mobile: 390px viewport must not scroll the body horizontally
// Asserts 0 page errors across every page + theme.
//
// Playwright is NOT a repo dependency. Run from a dir whose node_modules has it:
//   cp scripts/checks/redesign_wall_check.mjs /home/ajo/work/playwright-api/ \
//     && node /home/ajo/work/playwright-api/redesign_wall_check.mjs http://127.0.0.1:8700
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8700';
const errors = [];
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('PASS  ' + name); }
  else { failures++; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

const mockRuns = {
  active: { 'live-run-1': { pid: 1 } },
  runs: [
    { // job A round 1 (older)
      run_id: 'jobA-r1', run_name: 'redesign-demo', started_at: '2026-07-19T05:00:00Z',
      state: 'finished', elapsed_s: 120,
      feeder_totals: { total_tokens: 31591, input_tokens: 31032, output_tokens: 559, calls: 11 },
      tasks: [
        { key: 'haiku', name: 'haiku', status: 'fail', tokens: 11000, spec: 'Write haiku.txt with 3 lines.',
          check: 'python3 checks/haiku_check.py', check_returncode: 1,
          check_output_tail: ['FAIL: haiku.txt must have at least 3 non-empty lines.'],
          taskdir: '/tmp/demo/haiku', log_path: '/tmp/demo/haiku/worker.log',
          feeder: { latency_ms_p50: 2100, served: [{ platform: 'kilo', model_id: 'kimi-k2' }] },
          quality_score: 0.2 },
      ],
    },
    { // job A round 2 (newer)
      run_id: 'jobA-r2', run_name: 'redesign-demo', started_at: '2026-07-19T06:00:00Z',
      state: 'finished', elapsed_s: 95,
      feeder_totals: { total_tokens: 10000, input_tokens: 9000, output_tokens: 1000, calls: 4 },
      tasks: [
        { key: 'haiku', name: 'haiku', status: 'pass', tokens: 9100, spec: 'Write haiku.txt with 3 lines.',
          check: 'python3 checks/haiku_check.py', check_returncode: 0,
          check_output_tail: ['3 lines OK'],
          taskdir: '/tmp/demo/haiku2', log_path: '/tmp/demo/haiku2/worker.log',
          feeder: { latency_ms_p50: 1200, served: [{ platform: 'opencode', model_id: 'glm-5.2' }] },
          quality_score: 0.9 },
        { key: 'fizz', name: 'fizz', status: 'pass', tokens: 4800, spec: 'Implement fizzbuzz(n).',
          check: 'python3 -m py_compile fizzbuzz.py', check_returncode: 0,
          check_output_tail: 'compiled OK',
          feeder: { latency_ms_p50: 900, served: [{ platform: 'nvidia', model_id: 'nemotron-3' }] } },
      ],
    },
    { // job B, live
      run_id: 'live-run-1', run_name: 'live-job', started_at: '2026-07-19T06:30:00Z',
      state: 'live', elapsed_s: 30,
      tasks: [{ key: 'w1', name: 'w1', status: 'working', tokens: 500, activity: 'writing report.md', spec: 'Do a thing.' }],
    },
  ],
};

const mockTranscript = {
  status: 'ok',
  attempts: [{
    n: 1, outcome: 'pass', rc: 0,
    turns: [
      { role: 'orchestrator', kind: 'spec', text: 'Write haiku.txt with 3 lines.' },
      { role: 'worker', kind: 'text', text: 'Planning a 3-line haiku.', t_start: 1784868000000 },
      { role: 'worker', kind: 'tool', tool: 'write_file', input: { filePath: 'haiku.txt' }, t_start: 1784868002000 },
      { role: 'worker', kind: 'step', reason: 'done', tokens: { total: 1200 } },
    ],
  }],
};

const mockUsage = {
  usage: [
    { served_model: 'opencode/glm-5.2', task_class: 'coding', tasks: 6, passes: 5, first_try: 4, first_try_pass_rate: 0.667, pass_rate: 0.833, tokens: 90000 },
    { served_model: 'kilo/kimi-k2', task_class: 'reasoning', tasks: 4, passes: 2, first_try: 1, first_try_pass_rate: 0.25, pass_rate: 0.5, tokens: 200000 },
    { served_model: 'mock-model/mock-model', task_class: 'coding', tasks: 9, passes: 9, first_try: 9, first_try_pass_rate: 1, pass_rate: 1, tokens: 100 },
  ],
};

const mockQueue = [
  { id: 1, title: 'brief-11', status: 'todo', agent_code: 'lunk', priority: 1, created_at: '2026-07-19T06:00:00Z' },
  { id: 2, title: 'wire-probe', status: 'working', agent_code: 'ringer', claimed_by: 'runner', created_at: '2026-07-19T06:10:00Z' },
  { id: 3, title: 'old-job', status: 'done', agent_code: 'ringer', created_at: '2026-07-18T06:00:00Z' },
];

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
  await page.route('**/api/runs', (r) => r.fulfill(json(mockRuns)));
  // Real library shape: absolute filesystem path/report_path, NO url field —
  // the frontend must derive the served /artifacts/<rel> URL itself.
  await page.route('**/api/library', (r) => r.fulfill(json({ artifacts: {
    'redesign-demo': { state: 'final', versions: [
      { report_path: '/home/x/.ringer/artifacts/redesign-demo-v1-report.html', path: '/home/x/.ringer/artifacts/versions/redesign-demo/v1.html' },
      { report_path: '/home/x/.ringer/artifacts/redesign-demo-v2-report.html', path: '/home/x/.ringer/artifacts/versions/redesign-demo/v2.html' },
    ] },
  } })));
  await page.route('**/artifacts/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>artifact</h1>' }));
  await page.route('**/api/usage', (r) => r.fulfill(json(mockUsage)));
  await page.route('**/api/canon', (r) => r.fulfill(json({ models: [] })));
  await page.route('**/api/models', (r) => r.fulfill(json({ groups: [], rollup: [] })));
  await page.route('**/transcript/**', (r) => r.fulfill(json(mockTranscript)));
  // live-model resolves the REAL served model for the un-enriched live task w1;
  // every other task falls back to its feeder-enriched value (served:[] here).
  await page.route('**/live-model/**', (r) => {
    r.fulfill(json({ served: r.request().url().includes('/w1') ? [{ platform: 'nvidia', model_id: 'nemotron-3' }] : [] }));
  });
  await page.route('**/logs/**', (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: 'log line 1\nlog line 2' }));
  await page.route('**/agent-tasks?*', (r) => r.fulfill(json(mockQueue)));

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);

  // ── §1: all collapsed on load ──
  const jobRows = await page.locator('.job-row').count();
  check('two job rows render', jobRows === 2, 'got ' + jobRows);
  check('everything collapsed on load', await page.locator('.round').count() === 0);
  check('live job shows LIVE badge', await page.locator('.job-badge.live').count() === 1);

  // ── §4: KPI strip ──
  const tokSub = await page.locator('#kpi-tokens-sub').textContent();
  check('TOKENS sub shows in/out split', /in \/.*out/.test(tokSub), tokSub);
  const barW = await page.locator('#kpi-passed-bar').evaluate((e) => e.style.width);
  check('PASSED split bar has width', !!barW && barW !== '0%', barW);

  // ── §1: expand job → rounds newest first ──
  await page.locator('.job-row', { hasText: 'redesign-demo' }).locator('.job-head').click();
  await page.waitForTimeout(200);
  const roundLabels = await page.locator('.round-label').allTextContents();
  check('rounds render newest-first', roundLabels[0] === 'ROUND 2' && roundLabels[1] === 'ROUND 1', roundLabels.join(','));
  const split = await page.locator('.job-token-split').textContent();
  check('job token split sums rounds', split.includes('40,032') && split.includes('1,559') && split.includes('15 calls'), split);

  // ── §1: expand round → worker table ──
  await page.locator('.round', { hasText: 'ROUND 2' }).locator('.round-head').click();
  await page.waitForTimeout(200);
  check('worker table header renders', (await page.locator('.worker-thead').first().textContent()).includes('MODEL'));
  const haikuRow = page.locator('.round', { hasText: 'ROUND 2' }).locator('.worker-rowwrap', { hasText: 'haiku' });
  check('served model shown', (await haikuRow.locator('.w-model').textContent()).includes('glm-5.2'));
  check('latency shown', (await haikuRow.locator('.w-latency').textContent()).includes('1.2s'));
  const score = await haikuRow.locator('.w-score').textContent();
  check('SCORE shows grade/10 green', score.trim() === '9.0' && await haikuRow.locator('.w-score.good').count() === 1, score);
  const fizzScore = await page.locator('.worker-rowwrap', { hasText: 'fizz' }).locator('.w-score').textContent();
  check('ungraded task shows —', fizzScore.trim() === '—', fizzScore);

  // ── §1: worker detail tabs ──
  await haikuRow.locator('.worker-row').click();
  await page.waitForTimeout(600);
  check('detail opens on ACTIONS tab', await haikuRow.locator('.wd-tab.active', { hasText: 'ACTIONS' }).count() === 1);
  check('ACTIONS shows ORCH + WORKER turns',
    await haikuRow.locator('.wd-role.orch').count() >= 1 && await haikuRow.locator('.wd-role.worker').count() >= 2);
  await haikuRow.locator('.wd-tab', { hasText: 'BRIEF' }).click();
  check('BRIEF shows the spec', (await haikuRow.locator('.wd-brief').textContent()).includes('Write haiku.txt'));
  await haikuRow.locator('.wd-tab', { hasText: 'OUTPUT' }).click();
  check('OUTPUT shows check + rc chip', (await haikuRow.locator('.wd-check').textContent()).includes('haiku_check')
    && (await haikuRow.locator('.wd-rc').textContent()) === 'rc=0'
    && await haikuRow.locator('.wd-rc.good').count() === 1);
  check('OUTPUT shows file links', await haikuRow.locator('.wd-links a').count() === 2);

  // ── §1: expand-all toggle ──
  const expandAll = page.locator('.job-row', { hasText: 'redesign-demo' }).locator('.job-expand-all');
  check('expand-all label offers expand', (await expandAll.textContent()).includes('expand all'));
  await expandAll.click();
  await page.waitForTimeout(300);
  const openDetails = await page.locator('.job-row', { hasText: 'redesign-demo' }).locator('.worker-detail').count();
  check('expand-all opens every worker', openDetails === 3, 'got ' + openDetails);
  check('label flips to collapse all', (await expandAll.textContent()).includes('collapse all'));
  await expandAll.click();
  await page.waitForTimeout(300);
  check('collapse-all closes workers', await page.locator('.job-row', { hasText: 'redesign-demo' }).locator('.worker-detail').count() === 0);

  // ── §2: chip strip filter ──
  const chips = await page.locator('.job-chip').allTextContents();
  check('chip strip: ALL + 2 jobs', chips.length === 3 && chips[0] === 'ALL', chips.join('|'));
  check('live chip pulses', await page.locator('.job-chip', { hasText: 'live-job' }).locator('.chip-live-dot').count() === 1);
  await page.locator('.job-chip', { hasText: 'live-job' }).click();
  await page.waitForTimeout(200);
  check('chip filters jobs list', await page.locator('.job-row').count() === 1);
  await page.locator('.job-chip', { hasText: 'ALL' }).click();
  await page.waitForTimeout(200);
  check('ALL restores jobs list', await page.locator('.job-row').count() === 2);
  check('bottom bar is gone', await page.locator('#bottom-bar, .bottom-bar').count() === 0);

  // ── §6: un-enriched round row resolves the REAL model via /live-model ──
  const liveJob = page.locator('.job-row', { hasText: 'live-job' });
  await liveJob.locator('.job-head').click();
  await page.waitForTimeout(200);
  await liveJob.locator('.round-head').first().click();
  await page.waitForTimeout(700);
  const liveModel = await liveJob.locator('.worker-rowwrap', { hasText: 'w1' }).locator('.w-model').textContent();
  check('round table shows real served model, not feeder/auto',
    liveModel.includes('nemotron-3') && !liveModel.includes('feeder/auto'), liveModel);
  await liveJob.locator('.job-head').click(); // collapse back

  // ── §3: drawers ──
  const feedCount = await page.locator('#feed-count').textContent();
  check('feed count badge populated', Number(feedCount) >= 3, feedCount);
  await page.locator('#feed-btn').click();
  check('feed drawer opens with cards', await page.locator('#drawer-feed .feed-card').count() >= 3);
  await page.locator('#drawer-scrim').click();
  check('scrim closes drawer', await page.locator('#drawer').isHidden());
  await page.locator('#artifacts-btn').click();
  await page.waitForTimeout(400);
  const artOpts = await page.locator('#artifact-picker option').count();
  check('artifact picker populated', artOpts === 2, 'options ' + artOpts);
  await page.locator('#artifact-picker').selectOption('redesign-demo');
  await page.waitForTimeout(300);
  check('artifact preview iframe renders', await page.locator('#artifact-preview iframe').count() === 1);
  const iframeSrc = await page.locator('#artifact-preview iframe').getAttribute('src');
  check('preview src derived from report_path', /\/artifacts\/redesign-demo-v2-report\.html$/.test(iframeSrc || ''), iframeSrc);
  check('version picker has versions', await page.locator('#artifact-version option').count() === 2);
  check('open-in-new-tab link shown', await page.locator('#artifact-open').isVisible());
  await page.locator('#drawer-close').click();

  // ── §8: models page ──
  await page.locator('.nav-icon[data-page="models"]').click();
  await page.waitForTimeout(600);
  const classChips = await page.locator('.class-chip').allTextContents();
  check('wire-class chips from eval log', classChips.join(',') === 'ALL,CODING,REASONING', classChips.join(','));
  check('scoreboard ranks models', await page.locator('.score-grid-row').count() === 2);
  const modelCells = await page.locator('.sc-model').allTextContents();
  check('fixture models excluded', !modelCells.some((m) => m.includes('mock-model')), modelCells.join(','));
  check('rank #1 highlighted', await page.locator('.sc-rank.top').count() === 1);
  check('lab column derived', (await page.locator('.sc-lab').first().textContent()).length > 0);
  check('taxonomy footnote present', (await page.locator('.score-footnote').textContent()).includes('TAXONOMY'));
  await page.locator('.class-chip', { hasText: 'REASONING' }).click();
  check('class filter narrows rows', await page.locator('.score-grid-row').count() === 1);

  // ── §9: queue page ──
  await page.locator('.nav-icon[data-page="queue"]').click();
  await page.waitForTimeout(600);
  check('kanban renders 7 columns', await page.locator('.queue-col').count() === 7);
  check('queue cards land in columns', await page.locator('.queue-col[data-column="working"] .queue-card').count() === 1);
  check('file-job button present', await page.locator('[data-action="file-task"]').isVisible());

  // ── §10 + §5: theme designer ──
  await page.locator('.nav-icon[data-page="settings"]').click();
  await page.waitForTimeout(300);
  check('segmented base buttons', await page.locator('#designer-base button').count() === 4);
  check('accent swatches', await page.locator('#designer-swatches .swatch').count() === 4);
  check('rain intensity slider present', await page.locator('#designer-rain').isVisible());
  await page.locator('#designer-rain').fill('60');
  await page.waitForTimeout(200);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ringside-custom-theme') || '{}'));
  check('rain intensity persists', String(saved.rain) === '60', JSON.stringify(saved));

  // ── §5: rain only on h4, dim via opacity ──
  check('rain off on dark theme', await page.locator('.matrix-overlay').evaluate((e) => getComputedStyle(e).display) === 'none');
  await page.evaluate(() => document.getElementById('theme-label').click()); // dark → light
  await page.evaluate(() => document.getElementById('theme-label').click()); // light → h4
  await page.waitForTimeout(500);
  check('h4 shows rain overlay', await page.locator('.matrix-overlay').evaluate((e) => getComputedStyle(e).display) === 'block');
  const canvasOpacity = await page.locator('#matrix-canvas').evaluate((e) => e.style.opacity);
  check('rain opacity tracks intensity', Math.abs(Number(canvasOpacity) - 0.6) < 0.01, canvasOpacity);
  const glassBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--glass-bg').trim());
  check('h4 panels near-solid', glassBg.includes('0.92'), glassBg);
  await page.evaluate(() => document.getElementById('theme-label').click()); // h4 → dark
  await page.waitForTimeout(300);

  // ── light theme sanity (0 errors covered globally) ──
  await page.evaluate(() => document.getElementById('theme-label').click()); // dark → light
  await page.waitForTimeout(300);
  check('light theme applies', await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'light');
  await page.evaluate(() => { localStorage.setItem('ringside-theme', 'dark'); });

  // ── mobile reflow: dashboard must not scroll sideways ──
  await page.locator('.nav-icon[data-page="dashboard"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  // True horizontal overflow = an element whose right edge exceeds innerWidth.
  // (scrollWidth-innerWidth is a false positive of a few px when a vertical
  //  scrollbar coexists; the per-element edge test is artifact-free.)
  const widest = () => page.evaluate(() => {
    var iw = window.innerWidth, max = 0, who = '';
    document.querySelectorAll('body *').forEach(function (e) {
      if (getComputedStyle(e).position === 'fixed') return; // drawers/scrim off-canvas
      var r = e.getBoundingClientRect();
      if (r.right > max) { max = r.right; who = e.tagName + '.' + e.className; }
    });
    return { over: Math.max(0, Math.round(max - iw)), who: who };
  });
  var w1 = await widest();
  check('no horizontal body scroll at 390px', w1.over <= 2, w1.over + 'px past by ' + w1.who);
  await page.locator('.job-row', { hasText: 'redesign-demo' }).locator('.job-head').click();
  await page.waitForTimeout(300);
  var w2 = await widest();
  check('expanded job still no body overflow', w2.over <= 2, w2.over + 'px past by ' + w2.who);

  await browser.close();

  const realErrors = errors.filter((e) => !/favicon|net::ERR_ABORTED.*cdnjs|Failed to load resource.*chart/i.test(e));
  check('0 page errors', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));

  if (failures > 0) { console.error('\n' + failures + ' assertion(s) failed'); process.exit(1); }
  console.log('\nALL CHECKS PASSED');
};

run().catch((e) => { console.error('CHECK CRASHED:', e); process.exit(1); });
