/* ============================================================================
 * Ringside v2 — Dashboard logic for monitoring AI agent swarms
 * Self-contained IIFE. Calls init() on DOMContentLoaded.
 *
 * Dashboard = three-level progressive disclosure:
 *   job row → rounds → worker table → worker detail (BRIEF / ACTIONS / OUTPUT)
 * Everything starts collapsed; expand state lives in Maps keyed by stable ids
 * so the 1s poll re-render never collapses what the human opened.
 * ========================================================================= */
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────
  const state = {
    runs: [],
    active: {},
    artifacts: [],
    theme: localStorage.getItem('ringside-theme') || 'dark',
    currentPage: 'dashboard',
    expanded: new Map(),          // 'j:<jobName>' / 'r:<runId>' → true
    expandedWorkers: new Map(),   // '<runId>::<taskKey>' → true (pollers iterate this)
    workerTabs: new Map(),        // compositeKey → 'brief' | 'actions' | 'output'
    transcripts: new Map(),       // compositeKey → parsed /transcript payload
    liveModels: new Map(),        // compositeKey → parsed /live-model payload (real served model)
    selectedJob: '',              // '' = all jobs (chip strip filter)
    drawer: null,                 // null | 'feed' | 'artifact'
    feedEvents: [],
    selectedArtifact: '',
    artifactVersion: '',          // '' = latest
    modelsData: null,
    canon: [],            // feeder's real model catalog (/api/canon)
    usage: [],            // Ringer's served-model x class outcomes (/api/usage)
    modelsClass: 'all',   // selected wire_class chip on the Models scoreboard
    queue: { tasks: [], selected: null, mode: null }, // swarm work-queue kanban (/agent-tasks)
    apiBase: '',
    rainIntensity: 28,
    kirbyActive: false,
    kirbyShiftStart: 0,
    kirbyClickCount: 0,
    kirbyDanceActive: false,
  };

  let matrixAnimId = null;
  let matrixCanvas = null;

  // ── Kirby Data ───────────────────────────────────────────────────────────
  const KIRBYS = [
    "(b'.' )b", "p(-_-p)", "t('.'t)", "(>'.')>", "<('.'<)",
    "\\(^o^)/", "(b'O' )b", "q('.'q)", "(>'-')>", "d('.'d)",
    "\\('o')/", "(b*_* )b", "t(>.<t)", "m('.'m)", "(づ'.' )づ",
  ];
  const KIRBY_COLORS = [
    '#ff69b4', '#ff1493', '#00ff41', '#35d0ff', '#ff5f6b',
    '#ffd700', '#ff6347', '#7b68ee', '#00fa9a', '#ff4500',
    '#da70d6', '#32cd32', '#ff8c00', '#1e90ff', '#ff00ff',
  ];

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Coerce to number or return 0. */
  function numberOrZero(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /** Parse a time value (epoch-ms, ISO string, or seconds) into epoch-ms. */
  function parseTime(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  /** Format seconds into human-readable duration (e.g. "3m 12s"). */
  function formatDuration(s) {
    s = Math.round(numberOrZero(s));
    if (s < 0) s = 0;
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h + 'h ' + m + 'm';
  }

  /** Format token count compactly (e.g. 86600 → "86.6k"). */
  function formatTokens(n) {
    n = numberOrZero(n);
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  }

  /** Comma-group an integer (31591 -> "31,591"), fail-safe for non-numbers. */
  function withCommas(n) {
    return Math.round(numberOrZero(n)).toLocaleString('en-US');
  }

  /** Format a latency in ms (e.g. 1830 → "1.8s", 340 → "340ms"). */
  function formatLatency(ms) {
    ms = numberOrZero(ms);
    if (!ms) return '';
    if (ms < 1000) return Math.round(ms) + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  /**
   * Sum the per-round feeder token totals across every round of a job into one
   * job-level burn { total, input, output, calls }. Returns null if no round
   * has been enriched yet (so the header shows nothing rather than a bare "0").
   */
  function jobTokenBurn(job) {
    var total = 0, input = 0, output = 0, calls = 0, seen = false;
    (job.runs || []).forEach(function (run) {
      var ft = run.feederTotals;
      if (!ft || typeof ft !== 'object') return;
      seen = true;
      total += numberOrZero(ft.total_tokens);
      input += numberOrZero(ft.input_tokens);
      output += numberOrZero(ft.output_tokens);
      calls += numberOrZero(ft.calls);
    });
    return seen ? { total: total, input: input, output: output, calls: calls } : null;
  }

  /** Relative time-ago string from epoch-ms or ISO string. */
  function relativeAgo(v) {
    const ms = parseTime(v);
    if (!ms) return '';
    const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diff < 5) return 'just now';
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  /** Stable run identifier. */
  function runId(run, i) {
    return run.run_id || run.runId || run.id || 'run-' + i;
  }

  /** Format a feeder "served" array (platform/model_id, failovers joined with →). */
  function servedFromArray(served) {
    if (Array.isArray(served) && served.length) {
      return served.map(function (s) {
        return (s.platform ? s.platform + '/' : '') + (s.model_id || '');
      }).join(' → ');
    }
    return '';
  }

  /**
   * The model that ACTUALLY served this task, not the routed slug (feeder/auto/*).
   * Preference order: live /live-model (works for live AND finished runs while feeder
   * still has the session rows) → post-run feeder-enriched block → routed slug.
   */
  function servedModel(task, compositeKey) {
    if (compositeKey) {
      var live = state.liveModels.get(compositeKey);
      if (live) {
        var s = servedFromArray(live.served);
        if (s) return s;
        if (live.current && live.current.served_model) return live.current.served_model;
      }
    }
    var fed = task.feeder || {};
    var s2 = servedFromArray(fed.served);
    if (s2) return s2;
    return task.model || '';
  }

  /** Per-task latency (feeder-enriched p50, ms) or 0. */
  function taskLatency(task) {
    var fed = task.feeder || {};
    return numberOrZero(fed.latency_ms_p50);
  }

  /** Stable task key. */
  function taskKey(task, i) {
    return task.key || task.name || 'task-' + i;
  }

  /** Classify task state into a rendering kind. */
  function taskKind(task) {
    if (!task) return 'waiting';
    const s = (task.state || task.status || '').toLowerCase();
    if (s === 'pass' || s === 'passed' || s === 'done') return 'pass';
    if (s === 'working' || s === 'running' || s === 'active') return 'working';
    if (s === 'retry' || s === 'retrying') return 'retry';
    if (s === 'fail' || s === 'failed' || s === 'error') return 'fail';
    if (s === 'interrupted' || s === 'died' || s === 'aborted') return 'interrupted';
    return 'waiting';
  }

  /** Human label for task kind. */
  function taskStateText(kind) {
    const map = { pass: 'Passed', working: 'Working', retry: 'Retrying', fail: 'Failed', interrupted: 'Interrupted', waiting: 'Waiting' };
    return map[kind] || 'Waiting';
  }

  /** Icon character for task kind. */
  function kindIcon(kind) {
    var icons = { pass: '✓', working: '▶', retry: '↻', fail: '✗', interrupted: '⊘', waiting: '○' };
    return icons[kind] || '○';
  }

  /** Brief activity text for a task. */
  function taskActivity(task) {
    if (!task) return '';
    if (task.activity) return task.activity;
    const k = taskKind(task);
    if (k === 'working') return task.step || 'running...';
    if (k === 'retry') return 'attempt ' + (numberOrZero(task.attempt) + 1);
    return '';
  }

  /** First non-empty line of a string-or-array-of-lines. */
  function firstLine(v) {
    var s = Array.isArray(v) ? v.join('\n') : String(v == null ? '' : v);
    var lines = s.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim()) return lines[i].trim();
    }
    return '';
  }

  /** "LAST CHECK" cell: the most informative one-liner we have for the task. */
  function lastCheckNote(task) {
    var kind = taskKind(task);
    if (kind === 'working' || kind === 'retry') return taskActivity(task);
    var tail = firstLine(task.check_output_tail);
    if (kind === 'fail') return tail || (task.verdict ? String(task.verdict) : 'FAILED');
    if (kind === 'pass') {
      var rc = task.check_returncode;
      return tail || ('check rc=' + (rc == null ? 0 : rc));
    }
    return taskActivity(task) || '';
  }

  /** Strip ANSI escape codes from worker log text. */
  function stripAnsi(s) {
    if (Array.isArray(s)) s = s.join('\n');
    else if (s == null) s = '';
    else if (typeof s !== 'string') s = String(s);
    return s
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b\[[0-9;]{1,6}m/g, '');
  }

  // ── Data Normalization ───────────────────────────────────────────────────

  /**
   * Normalize the /api/runs payload into a sorted array of runs,
   * each with computed pass/fail/done counts and total tokens.
   */
  function normalizeRuns(payload) {
    if (!payload) return;
    const raw = Array.isArray(payload.runs) ? payload.runs : [];
    state.active = payload.active || {};

    state.runs = raw.map(function (run, ri) {
      const id = runId(run, ri);
      const tasks = Array.isArray(run.tasks) ? run.tasks : [];
      let pass = 0, fail = 0, done = 0, tokens = 0;

      tasks.forEach(function (t) {
        const k = taskKind(t);
        if (k === 'pass') { pass++; done++; }
        else if (k === 'fail') { fail++; done++; }
        else if (k === 'working' || k === 'retry') { /* in progress */ }
        else { /* waiting */ }
        tokens += numberOrZero(t.tokens || t.totalTokens);
      });

      return {
        id: id,
        label: run.run_name || run.label || run.name || id,
        runName: run.run_name || run.label || run.name || id,
        tasks: tasks,
        pass: pass,
        fail: fail,
        done: done,
        total: tasks.length,
        tokens: tokens,
        elapsedS: numberOrZero(run.elapsed_s),
        startedAt: parseTime(run.started_at || run.startedAt || run.started),
        finishedAt: parseTime(run.finished_at || run.finishedAt),
        isLive: run.state === 'live' || !!state.active[id],
        // Per-run token burn, written into the run JSON post-run by
        // scripts/feeder_enrich.py (state.feeder_totals). Null until enriched.
        feederTotals: run.feeder_totals || null,
        raw: run,
      };
    });

    // Sort: live runs first, then most recent start
    state.runs.sort(function (a, b) {
      if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });

    state.feedEvents = collectFeedEvents();
  }

  /**
   * Server serves artifact files at /artifacts/<path-relative-to-the-artifact-root>.
   * The library payload only carries absolute filesystem paths, so derive the
   * served URL here — everything under the root sits after the last '/artifacts/'
   * segment. Prefer the rendered report over the raw snapshot.
   */
  function artifactUrl(absPath) {
    if (!absPath || typeof absPath !== 'string') return '';
    var i = absPath.lastIndexOf('/artifacts/');
    if (i < 0) return '';
    return apiUrl('/artifacts/' + absPath.slice(i + '/artifacts/'.length));
  }

  /** Normalize the /api/library payload into an artifacts array. */
  function normalizeLibrary(payload) {
    if (!payload || !payload.artifacts) return;
    const arts = payload.artifacts;
    state.artifacts = Object.keys(arts).map(function (name) {
      const a = arts[name];
      var versions = (Array.isArray(a.versions) ? a.versions : []).map(function (v) {
        var url = v.url || artifactUrl(v.report_path) || artifactUrl(v.path);
        return Object.assign({}, v, { url: url });
      });
      return {
        name: name,
        state: a.state || 'unknown',
        versions: versions,
        raw: a,
      };
    });
  }

  // ── Fetch ────────────────────────────────────────────────────────────────

  function fetchRuns() {
    fetch(apiUrl('/api/runs'), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        normalizeRuns(data);
        render();
        fetchExpandedWorkerLogs();
        fetchExpandedTranscripts();
        fetchLiveModels();
      })
      .catch(function () { /* swallow — don't crash rendering */ });
  }

  function fetchLibrary() {
    fetch(apiUrl('/api/library'), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        normalizeLibrary(data);
        if (state.drawer === 'artifact') updateArtifactDrawer();
      })
      .catch(function () {});
  }

  function fetchModels() {
    // Real feeder catalog + Ringer's own served-model outcomes (plus legacy scoreboard).
    var get = function (p) { return fetch(apiUrl(p), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); };
    Promise.all([get('/api/models'), get('/api/canon'), get('/api/usage')]).then(function (res) {
      if (res[0]) state.modelsData = res[0];
      if (res[1]) state.canon = res[1].models || [];
      if (res[2]) state.usage = res[2].usage || [];
      render();
      renderModelsPage();
      setTimeout(buildAnalytics, 100);
    });
  }

  function apiUrl(path) { return state.apiBase + path; }

  // ── Swarm Queue (kanban over the agent-API) ────────────────────────────────
  var QUEUE_COLUMNS = [
    { key: 'standing', label: 'Standing' },
    { key: 'todo', label: 'To do' },
    { key: 'working', label: 'Working' },
    { key: 'needs_input', label: 'Needs input' },
    { key: 'review', label: 'Review' },
    { key: 'done', label: 'Done' },
    { key: 'failed', label: 'Failed' },
  ];

  function qesc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function qapi(method, path, body) {
    return fetch(apiUrl(path), {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, json: j }; }); });
  }

  function fetchQueue() {
    fetch(apiUrl('/agent-tasks?limit=300'), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (tasks) {
        state.queue.tasks = Array.isArray(tasks) ? tasks : [];
        renderQueue();
      })
      .catch(function () { /* leave last-known board up */ });
  }

  function renderQueue() {
    var board = document.getElementById('kanban-board');
    if (!board) return;
    var tasks = state.queue.tasks || [];
    var byStatus = {};
    QUEUE_COLUMNS.forEach(function (c) { byStatus[c.key] = []; });
    tasks.forEach(function (t) { (byStatus[t.status] || (byStatus[t.status] = [])).push(t); });

    var html = QUEUE_COLUMNS.map(function (col) {
      var items = byStatus[col.key] || [];
      var cards = items.map(function (t) {
        return '<div class="queue-card" data-task-id="' + t.id + '" data-status="' + qesc(t.status) + '" role="button" tabindex="0">' +
          '<div class="queue-card-title">' + qesc(t.title || ('task #' + t.id)) + '</div>' +
          '<div class="queue-card-meta">' +
            '<span data-field="id">#' + t.id + '</span>' +
            '<span class="queue-chip" data-field="agent">' + qesc(t.agent_code) + '</span>' +
            (t.priority ? '<span data-field="priority">p' + qesc(t.priority) + '</span>' : '') +
            (t.attempts ? '<span data-field="attempts">try ' + qesc(t.attempts) + '</span>' : '') +
            (t.claimed_by ? '<span data-field="claimed">@' + qesc(t.claimed_by) + '</span>' : '') +
            '<span class="queue-age" data-field="age">' + qesc(relativeAgo(t.updated_at || t.created_at) || '') + '</span>' +
          '</div>' +
          (t.blocked_reason ? '<div class="queue-card-blocked" data-field="blocked">' + qesc(t.blocked_reason) + '</div>' : '') +
        '</div>';
      }).join('');
      return '<div class="queue-col" data-column="' + col.key + '">' +
        '<div class="queue-col-head"><span>' + col.label + '</span><span class="queue-col-count" data-count>' + items.length + '</span></div>' +
        '<div class="queue-col-body" data-column-body>' + (cards || '<div class="queue-empty">&mdash;</div>') + '</div>' +
      '</div>';
    }).join('');
    board.innerHTML = html;

    var meta = document.querySelector('[data-queue-meta]');
    if (meta) meta.textContent = tasks.length + ' task' + (tasks.length === 1 ? '' : 's');

    board.querySelectorAll('.queue-card').forEach(function (card) {
      var open = function () { openTask(Number(card.dataset.taskId)); };
      card.addEventListener('click', open);
      card.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  function openTask(id) {
    state.queue.selected = id;
    state.queue.mode = 'view';
    fetch(apiUrl('/agent-tasks/' + id), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data && data.task) renderTaskModal(data.task, data.receipts || []); });
  }

  function openFileForm() {
    state.queue.selected = null;
    state.queue.mode = 'file';
    renderFileModal();
  }

  function closeModal() {
    state.queue.selected = null;
    state.queue.mode = null;
    var m = document.getElementById('queue-modal');
    if (m) m.setAttribute('hidden', '');
  }

  function showModal(inner) {
    var m = document.getElementById('queue-modal');
    var card = m && m.querySelector('[data-queue-modal-card]');
    if (!m || !card) return;
    card.innerHTML = inner;
    m.removeAttribute('hidden');
    card.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', closeModal); });
  }

  function renderTaskModal(task, receipts) {
    var thread = receipts.map(function (r) {
      return '<li class="queue-receipt" data-receipt-type="' + qesc(r.receipt_type) + '">' +
        '<span class="queue-receipt-type">' + qesc(r.receipt_type) + '</span> ' +
        '<span class="queue-receipt-agent">' + qesc(r.agent_code) + '</span>' +
        (r.body ? '<pre class="queue-receipt-body">' + qesc(r.body) + '</pre>' : '') +
      '</li>';
    }).join('') || '<li class="queue-empty">no receipts yet</li>';

    var controls = '<div class="queue-actions" data-queue-actions>';
    if (task.status === 'needs_input') {
      controls += '<textarea data-answer placeholder="Answer this task’s question…" rows="3"></textarea>' +
                  '<button class="control-button" data-act="answer">Answer &amp; re-queue</button>';
    }
    if (task.status !== 'done' && task.status !== 'todo' && task.status !== 'standing') {
      controls += '<button class="control-button" data-act="requeue">Re-queue</button>';
    }
    if (task.status !== 'done') {
      controls += '<button class="control-button" data-act="done">Mark done</button>';
    }
    controls += '<button class="control-button" data-act="prio-up">Priority +</button>';
    controls += '<button class="text-button" data-close>Close</button>';
    controls += '</div>';

    showModal(
      '<div class="queue-modal-head"><div class="panel-title">#' + task.id + ' ' + qesc(task.title || '') + '</div>' +
        '<button class="text-button" data-close aria-label="Close">✕</button></div>' +
      '<div class="queue-modal-sub" data-field="status">' + qesc(task.status) +
        (task.claimed_by ? ' · @' + qesc(task.claimed_by) : '') +
        ' · ' + qesc(task.agent_code) + ' · p' + qesc(task.priority || 0) + '</div>' +
      (task.body ? '<details class="queue-body"><summary>manifest / body</summary><pre>' + qesc(task.body) + '</pre></details>' : '') +
      controls +
      '<div class="queue-thread-head">Receipts</div><ul class="queue-thread">' + thread + '</ul>'
    );

    var card = document.querySelector('[data-queue-modal-card]');
    if (!card) return;
    var act = function (name, fn) { var b = card.querySelector('[data-act="' + name + '"]'); if (b) b.addEventListener('click', fn); };
    act('answer', function () {
      var ta = card.querySelector('[data-answer]');
      var text = ta ? ta.value.trim() : '';
      if (!text) { if (ta) ta.focus(); return; }
      qapi('PATCH', '/agent-tasks/' + task.id, { agent_code: 'adam', status: 'todo',
        blocked_reason: null, receipt_type: 'UNBLOCKED', receipt_body: text })
        .then(afterAction);
    });
    act('requeue', function () {
      qapi('PATCH', '/agent-tasks/' + task.id, { agent_code: 'adam', status: 'todo',
        receipt_type: 'RESUMED', receipt_body: 'manually re-queued from the board' }).then(afterAction);
    });
    act('done', function () {
      qapi('PATCH', '/agent-tasks/' + task.id, { agent_code: 'adam', status: 'done',
        receipt_type: 'DONE', receipt_body: 'manually marked done from the board' }).then(afterAction);
    });
    act('prio-up', function () {
      qapi('PATCH', '/agent-tasks/' + task.id, { agent_code: 'adam', priority: (task.priority || 0) + 1 }).then(afterAction);
    });
  }

  function renderFileModal() {
    showModal(
      '<div class="queue-modal-head"><div class="panel-title">File a swarm job</div>' +
        '<button class="text-button" data-close aria-label="Close">✕</button></div>' +
      '<label class="queue-label">Title<input data-file-title placeholder="short job name"></label>' +
      '<label class="queue-label">Body (ringer manifest JSON, or intent)<textarea data-file-body rows="10" ' +
        'placeholder=\'{"run_name":"...","tasks":[...]}\'></textarea></label>' +
      '<div class="queue-actions"><button class="control-button" data-file-submit>File job</button>' +
        '<button class="text-button" data-close>Cancel</button></div>' +
      '<div class="queue-file-error" data-file-error hidden></div>'
    );
    var card = document.querySelector('[data-queue-modal-card]');
    if (!card) return;
    var submit = card.querySelector('[data-file-submit]');
    if (submit) submit.addEventListener('click', function () {
      var title = (card.querySelector('[data-file-title]') || {}).value || '';
      var body = (card.querySelector('[data-file-body]') || {}).value || '';
      var err = card.querySelector('[data-file-error]');
      if (!title.trim()) { if (err) { err.textContent = 'Title is required.'; err.removeAttribute('hidden'); } return; }
      qapi('POST', '/agent-tasks', { agent_code: 'ringer', title: title.trim(), body: body }).then(function (res) {
        if (res.ok) { afterAction(res); }
        else if (err) { err.textContent = 'File failed: ' + (res.json && res.json.detail || res.status); err.removeAttribute('hidden'); }
      });
    });
  }

  function afterAction(res) {
    if (res && res.ok === false) return; // leave modal open on error
    closeModal();
    fetchQueue();
  }

  function setupQueue() {
    var fileBtn = document.querySelector('[data-action="file-task"]');
    if (fileBtn) fileBtn.addEventListener('click', openFileForm);
    var backdrop = document.getElementById('queue-modal');
    if (backdrop) backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && backdrop && !backdrop.hasAttribute('hidden')) closeModal();
    });
  }

  /** Fetch log for each expanded, still-running worker. */
  function fetchExpandedWorkerLogs() {
    state.expandedWorkers.forEach(function (_v, compositeKey) {
      var parts = compositeKey.split('::');
      var rid = parts[0];
      var tkey = parts[1];

      // Only fetch if the task is still running
      var run = state.runs.find(function (r) { return r.id === rid; });
      if (!run) return;
      var task = run.tasks.find(function (t, ti) { return taskKey(t, ti) === tkey; });
      if (!task) return;
      var kind = taskKind(task);
      var running = (kind === 'working' || kind === 'retry');
      // running: poll the live log each tick; finished: fetch the full log ONCE.
      // If the file was reaped (/tmp), the fetch 404s and we keep the seeded tail.
      if (!running && state.expandedWorkers.get(compositeKey) === 'full') return;

      fetch(apiUrl('/logs/' + encodeURIComponent(rid) + '/' + encodeURIComponent(tkey)), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (text) {
          if (text) {
            updateWorkerLog(compositeKey, stripAnsi(text));
            if (!running) state.expandedWorkers.set(compositeKey, 'full');
          }
        })
        .catch(function () {});
    });
  }

  /** Update a worker's log <pre> element with scroll-pinning. */
  function updateWorkerLog(compositeKey, text) {
    var el = document.querySelector('[data-log-key="' + compositeKey + '"]');
    if (!el) return;

    // Pin to bottom if user hasn't scrolled up
    var pinned = (el.scrollTop + el.clientHeight >= el.scrollHeight - 20);
    el.textContent = text;
    if (pinned) {
      el.scrollTop = el.scrollHeight;
    }
  }

  // ── Theme System ─────────────────────────────────────────────────────────

  /** Apply theme by name: 'dark' | 'light' | 'h4'. */
  function setTheme(name) {
    state.theme = name;
    document.documentElement.setAttribute('data-theme', name);
    localStorage.setItem('ringside-theme', name);

    if (name === 'h4' && state.rainIntensity > 0) {
      startMatrixRain();
    } else {
      stopMatrixRain();
    }
  }

  /** Cycle through themes: dark → light → h4 → dark. */
  function cycleTheme() {
    var order = ['dark', 'light', 'h4'];
    var idx = order.indexOf(state.theme);
    setTheme(order[(idx + 1) % order.length]);
    render();
    // Rebuild charts with theme-appropriate colors
    if (state.currentPage === 'analytics' || state.currentPage === 'models') {
      setTimeout(buildAnalytics, 100);
    }
  }

  /** Start the full-screen matrix rain canvas effect (h4 only).
   * Draw color is deliberately dim (#0a7d2b) and the canvas element opacity
   * tracks the rain-intensity setting so panels always win. */
  function startMatrixRain() {
    if (matrixAnimId) return;

    matrixCanvas = document.getElementById('matrix-canvas');
    var overlay = document.querySelector('.matrix-overlay');
    if (!matrixCanvas || !overlay) return;
    overlay.style.display = 'block';

    var ctx = matrixCanvas.getContext('2d');
    var chars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789@#$%^&*';
    var fontSize = 14;
    var columns;
    var drops;

    function resize() {
      if (!matrixCanvas) return;
      matrixCanvas.width = window.innerWidth;
      matrixCanvas.height = window.innerHeight;
      columns = Math.floor(matrixCanvas.width / fontSize);
      drops = new Array(columns);
      for (var i = 0; i < columns; i++) {
        drops[i] = Math.random() * -100;
      }
    }

    resize();
    window.addEventListener('resize', resize);

    function draw() {
      if (!matrixCanvas) return;
      var intensity = Math.max(0, Math.min(100, numberOrZero(state.rainIntensity)));
      if (intensity === 0) { stopMatrixRain(); return; }
      matrixCanvas.style.opacity = String(intensity / 100);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.07)';
      ctx.fillRect(0, 0, matrixCanvas.width, matrixCanvas.height);
      ctx.fillStyle = '#0a7d2b';
      ctx.font = fontSize + 'px monospace';

      for (var i = 0; i < columns; i++) {
        var ch = chars.charAt(Math.floor(Math.random() * chars.length));
        var x = i * fontSize;
        var y = drops[i] * fontSize;
        ctx.fillText(ch, x, y);

        if (y > matrixCanvas.height && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i] += 0.5;
      }

      matrixAnimId = requestAnimationFrame(draw);
    }

    matrixAnimId = requestAnimationFrame(draw);
  }

  /** Stop and hide matrix rain. */
  function stopMatrixRain() {
    if (matrixAnimId) {
      cancelAnimationFrame(matrixAnimId);
      matrixAnimId = null;
    }
    var overlay = document.querySelector('.matrix-overlay');
    if (overlay) overlay.style.display = 'none';
    matrixCanvas = null;
  }

  /** React to a rain-intensity change (designer slider). */
  function applyRainIntensity(value) {
    state.rainIntensity = Math.max(0, Math.min(100, numberOrZero(value)));
    if (state.theme !== 'h4') return;
    if (state.rainIntensity === 0) stopMatrixRain();
    else if (!matrixAnimId) startMatrixRain();
  }

  // ── DOM Helpers ──────────────────────────────────────────────────────────

  /** Create element with optional class, attributes, and children. */
  function el(tag, opts) {
    var node = document.createElement(tag);
    if (!opts) return node;
    if (opts.className) node.className = opts.className;
    if (opts.text) node.textContent = opts.text;
    if (opts.attrs) {
      Object.keys(opts.attrs).forEach(function (k) {
        node.setAttribute(k, opts.attrs[k]);
      });
    }
    if (opts.style) node.style.cssText = opts.style;
    if (opts.onclick) node.addEventListener('click', opts.onclick);
    if (opts.children) {
      opts.children.forEach(function (c) { if (c) node.appendChild(c); });
    }
    return node;
  }

  /** Create a text node. */
  function txt(s) {
    return document.createTextNode(s || '');
  }

  // ── Morph (flicker-free DOM reconciliation) ──────────────────────────────

  /** Sync attributes from `want` onto `have`. */
  function syncAttrs(have, want) {
    // Remove attributes not in want
    var haveAttrs = have.attributes;
    for (var i = haveAttrs.length - 1; i >= 0; i--) {
      var name = haveAttrs[i].name;
      if (!want.hasAttribute(name)) {
        have.removeAttribute(name);
      }
    }
    // Set attributes from want
    var wantAttrs = want.attributes;
    for (var j = 0; j < wantAttrs.length; j++) {
      var attr = wantAttrs[j];
      if (have.getAttribute(attr.name) !== attr.value) {
        have.setAttribute(attr.name, attr.value);
      }
    }
  }

  /**
   * Morph an existing DOM node to match a desired node,
   * minimizing DOM mutations for flicker-free updates.
   */
  function morphNode(have, want) {
    if (!have || !want) return want || have;

    // Different node types or tags — full replace
    if (have.nodeType !== want.nodeType) {
      have.replaceWith(want);
      return want;
    }

    // Text nodes
    if (have.nodeType === 3) {
      if (have.textContent !== want.textContent) {
        have.textContent = want.textContent;
      }
      return have;
    }

    // Element nodes
    if (have.nodeType === 1) {
      if (have.tagName !== want.tagName) {
        have.replaceWith(want);
        return want;
      }
      // Preserve a user-toggled <details> open state across the 1s re-render
      // (rendered nodes are always closed, so syncAttrs would otherwise snap it shut).
      var keepOpen = have.tagName === 'DETAILS' ? have.open : null;
      syncAttrs(have, want);
      if (keepOpen !== null) have.open = keepOpen;
      morphChildren(have, want);
    }

    return have;
  }

  /** Reconcile child lists using data-key for stable matching. */
  function morphChildren(have, want) {
    var haveKids = Array.from(have.childNodes);
    var wantKids = Array.from(want.childNodes);

    // Build key maps for element children
    var haveByKey = {};
    haveKids.forEach(function (c) {
      if (c.nodeType === 1 && c.dataset && c.dataset.key) {
        haveByKey[c.dataset.key] = c;
      }
    });

    var usedKeys = {};
    var hi = 0;

    for (var wi = 0; wi < wantKids.length; wi++) {
      var wantChild = wantKids[wi];
      var key = (wantChild.nodeType === 1 && wantChild.dataset) ? wantChild.dataset.key : null;
      var matched = null;

      if (key && haveByKey[key]) {
        matched = haveByKey[key];
        usedKeys[key] = true;
        // Move into position if needed
        if (have.childNodes[wi] !== matched) {
          have.insertBefore(matched, have.childNodes[wi] || null);
        }
        morphNode(matched, wantChild);
      } else if (!key && hi < haveKids.length && haveKids[hi] && !haveKids[hi].dataset?.key) {
        // Positional fallback for non-keyed nodes
        matched = haveKids[hi];
        morphNode(matched, wantChild);
        hi++;
      } else {
        // Insert new node
        have.insertBefore(wantChild, have.childNodes[wi] || null);
      }
    }

    // Remove excess children
    while (have.childNodes.length > wantKids.length) {
      have.removeChild(have.lastChild);
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  /** Master render — re-renders all visible sections. */
  function render() {
    updateTopbar();
    updateKPIs();

    if (state.currentPage === 'dashboard') {
      morphInto('#job-chips', renderJobChips());
      morphInto('#runs-container', renderJobs());
    }

    if (state.drawer === 'feed') updateFeedDrawer();
  }

  /** Morph content into a container selected by CSS selector. */
  function morphInto(selector, content) {
    var container = document.querySelector(selector);
    if (!container || !content) return;
    morphChildren(container, content);
  }

  // ── Topbar ───────────────────────────────────────────────────────────────

  /** Update topbar elements in-place (no morphing — preserves static HTML structure). */
  function updateTopbar() {
    // Live badge
    var liveCount = state.runs.filter(function (r) { return r.isLive; }).length;
    var badge = document.getElementById('live-badge');
    if (badge) {
      badge.hidden = false;
      badge.classList.toggle('active', liveCount > 0);
      var countEl = document.getElementById('live-count');
      if (countEl) countEl.textContent = liveCount > 0 ? liveCount + (liveCount === 1 ? ' SWARM LIVE' : ' SWARMS LIVE') : 'IDLE';
    }

    // Feed count
    var feedCount = document.getElementById('feed-count');
    if (feedCount) feedCount.textContent = String(state.feedEvents.length);

    // Theme label
    var themeLabel = document.getElementById('theme-label');
    if (themeLabel) {
      var icons = { dark: '☽ Dark', light: '☀ Light', h4: '◉ h4' };
      themeLabel.textContent = icons[state.theme] || state.theme;
    }
  }

  /** Format clock for topbar display. */
  function formatClock() {
    var d = new Date();
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /** Tick the clock element. */
  function tickClock() {
    var clockEl = document.getElementById('clock');
    if (clockEl) clockEl.textContent = formatClock();
  }

  // ── KPI Strip ────────────────────────────────────────────────────────────

  /** Update KPI values in-place by ID (no morphing — preserves static HTML structure). */
  function updateKPIs() {
    var activeWorkers = 0, passed = 0, failed = 0, totalTokens = 0;
    var earliest = Infinity, totalDone = 0, totalTasks = 0;
    var ftIn = 0, ftOut = 0, ftSeen = false;

    state.runs.forEach(function (run) {
      totalTasks += run.total;
      passed += run.pass;
      failed += run.fail;
      totalDone += run.done;
      totalTokens += run.tokens;
      if (run.startedAt && run.startedAt < earliest) earliest = run.startedAt;
      if (run.feederTotals) {
        ftSeen = true;
        ftIn += numberOrZero(run.feederTotals.input_tokens);
        ftOut += numberOrZero(run.feederTotals.output_tokens);
      }

      run.tasks.forEach(function (t) {
        var k = taskKind(t);
        if (k === 'working' || k === 'retry') activeWorkers++;
      });
    });

    var elapsed = earliest < Infinity ? (Date.now() - earliest) / 1000 : 0;
    var throughput = elapsed > 0 ? (totalDone / (elapsed / 60)).toFixed(1) : '0';

    function setKPI(id, value, sub) {
      var el = document.getElementById(id);
      if (el) el.textContent = value;
      if (sub) {
        var subEl = document.getElementById(id + '-sub');
        if (subEl) subEl.textContent = sub;
      }
    }

    setKPI('kpi-active', String(activeWorkers), activeWorkers > 0 ? 'working' : 'idle');
    var activeEl = document.getElementById('kpi-active');
    if (activeEl) activeEl.classList.toggle('working', activeWorkers > 0);
    setKPI('kpi-passed', String(passed), totalTasks > 0 ? ((passed / totalTasks * 100).toFixed(0) + '% pass rate') : '—');
    var passBar = document.getElementById('kpi-passed-bar');
    if (passBar) {
      var denom = passed + failed;
      passBar.style.width = denom > 0 ? (passed / denom * 100).toFixed(0) + '%' : '0%';
    }
    setKPI('kpi-failed', String(failed));
    setKPI('kpi-tokens', formatTokens(totalTokens),
      ftSeen ? (formatTokens(ftIn) + ' in / ' + formatTokens(ftOut) + ' out') : '—');
    setKPI('kpi-elapsed', formatDuration(elapsed), 'oldest run');
    setKPI('kpi-throughput', throughput, 'tasks/min');
  }

  // ── Jobs list: three-level progressive disclosure ────────────────────────

  /** Group state.runs into jobs by run_name (a job's runs are its rounds). */
  function groupJobs() {
    var jobs = [];
    var byName = {};
    state.runs.forEach(function (run) {
      var name = run.runName || run.label;
      if (!byName[name]) { byName[name] = { name: name, runs: [] }; jobs.push(byName[name]); }
      byName[name].runs.push(run);
    });
    jobs.forEach(function (j) {
      j.runs.sort(function (a, b) { return (a.startedAt || 0) - (b.startedAt || 0); }); // round 1..N
      j.isLive = j.runs.some(function (r) { return r.isLive; });
      j.latest = j.runs[j.runs.length - 1];
      j.pass = 0; j.fail = 0; j.tokens = 0; j.elapsedS = 0;
      j.runs.forEach(function (r) {
        j.pass += r.pass; j.fail += r.fail;
        j.tokens += r.tokens; j.elapsedS += r.elapsedS;
      });
    });
    jobs.sort(function (a, b) {
      if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
      return (b.latest.startedAt || 0) - (a.latest.startedAt || 0);
    });
    return jobs;
  }

  /** Chip strip under the KPIs: ALL + one chip per job; live jobs pulse. */
  function renderJobChips() {
    var wrapper = el('div');
    var jobs = groupJobs();

    var allChip = el('button', {
      className: 'job-chip' + (state.selectedJob === '' ? ' active' : ''),
      text: 'ALL',
      attrs: { 'data-key': 'chip-all', type: 'button' },
      onclick: function () { state.selectedJob = ''; render(); },
    });
    wrapper.appendChild(allChip);

    jobs.forEach(function (job) {
      var chip = el('button', {
        className: 'job-chip' + (state.selectedJob === job.name ? ' active' : ''),
        attrs: { 'data-key': 'chip-' + job.name, type: 'button' },
        onclick: function () {
          state.selectedJob = (state.selectedJob === job.name) ? '' : job.name;
          render();
        },
      });
      if (job.isLive) chip.appendChild(el('span', { className: 'chip-live-dot' }));
      chip.appendChild(txt(job.name));
      wrapper.appendChild(chip);
    });

    return wrapper;
  }

  function isExpanded(key) { return state.expanded.has(key); }
  function toggleExpanded(key) {
    if (state.expanded.has(key)) state.expanded.delete(key);
    else {
      state.expanded.set(key, true);
      // Opening a round: resolve the REAL served model for every worker row at
      // once (the MODEL column), not only when a single worker is expanded.
      if (key.indexOf('r:') === 0) fetchLiveModels();
    }
    render();
  }

  /**
   * Composite keys whose worker row is currently visible: every task in an
   * expanded round, plus any individually-expanded worker. /live-model is cheap
   * and populates the MODEL column, so we resolve it for all visible rows (the
   * heavier transcript/log pollers stay scoped to expanded workers only).
   */
  function liveModelTargets() {
    var keys = {};
    state.expandedWorkers.forEach(function (_v, k) { keys[k] = true; });
    state.runs.forEach(function (run) {
      if (!state.expanded.has('r:' + run.id)) return;
      (run.tasks || []).forEach(function (task, ti) {
        keys[run.id + '::' + taskKey(task, ti)] = true;
      });
    });
    return Object.keys(keys);
  }

  /** Level 1+2+3: job rows → rounds → worker table. */
  function renderJobs() {
    var wrapper = el('div');

    if (state.runs.length === 0) {
      wrapper.appendChild(el('div', {
        className: 'empty-state',
        text: 'No runs yet. Waiting for data...',
        attrs: { 'data-key': 'empty' },
      }));
      return wrapper;
    }

    var jobs = groupJobs().filter(function (j) {
      return !state.selectedJob || j.name === state.selectedJob;
    });

    jobs.forEach(function (job) {
      var jKey = 'j:' + job.name;
      var jOpen = isExpanded(jKey);
      var group = el('div', {
        className: 'job-row' + (job.isLive ? ' live' : '') + (jOpen ? ' open' : ''),
        attrs: { 'data-key': 'job-' + job.name },
      });

      // Level 1 — the job header row
      var header = el('div', {
        className: 'job-head',
        attrs: { role: 'button', tabindex: '0' },
        onclick: function () { toggleExpanded(jKey); },
      });
      header.appendChild(el('span', { className: 'job-caret', text: jOpen ? '▾' : '▸' }));
      header.appendChild(el('span', { className: 'job-dot' + (job.isLive ? ' live' : '') }));
      header.appendChild(el('span', { className: 'job-name', text: job.name }));
      header.appendChild(el('span', {
        className: 'job-rounds',
        text: job.runs.length + (job.runs.length === 1 ? ' round' : ' rounds'),
      }));
      var chips = el('span', { className: 'job-passfail' });
      chips.appendChild(el('span', { className: 'chip-pass', text: '✓' + job.pass }));
      chips.appendChild(el('span', { className: 'chip-fail', text: '✗' + job.fail }));
      header.appendChild(chips);
      var burn = jobTokenBurn(job);
      header.appendChild(el('span', {
        className: 'job-tokens',
        text: formatTokens(burn ? burn.total : job.tokens) + ' tok',
      }));
      header.appendChild(el('span', { className: 'job-elapsed', text: job.elapsedS ? formatDuration(job.elapsedS) : relativeAgo(job.latest.startedAt) }));
      var total = job.pass + job.fail;
      var bar = el('span', { className: 'job-bar' });
      bar.appendChild(el('span', { style: 'width:' + (total ? (job.pass / total * 100).toFixed(0) : 0) + '%' }));
      header.appendChild(bar);
      header.appendChild(el('span', {
        className: 'job-badge' + (job.isLive ? ' live' : ''),
        text: job.isLive ? 'LIVE' : 'DONE',
      }));
      group.appendChild(header);

      // Level 2 — expanded: token split + expand-all + round panels
      if (jOpen) {
        var body = el('div', { className: 'job-body' });

        var metaRow = el('div', { className: 'job-meta-row' });
        if (burn) {
          metaRow.appendChild(el('span', {
            className: 'job-token-split',
            text: 'TOKENS ' + withCommas(burn.input) + ' in / ' + withCommas(burn.output) + ' out'
              + (burn.calls ? ' · ' + withCommas(burn.calls) + ' calls' : ''),
          }));
        }
        // Every expandable key under this job (rounds + workers), for expand-all.
        var jobKeys = [];
        job.runs.forEach(function (run) {
          jobKeys.push('r:' + run.id);
          (run.tasks || []).forEach(function (task, ti) {
            jobKeys.push(run.id + '::' + taskKey(task, ti));
          });
        });
        var anyClosed = jobKeys.some(function (k) {
          return k.indexOf('::') >= 0 ? !state.expandedWorkers.has(k) : !state.expanded.has(k);
        });
        metaRow.appendChild(el('button', {
          className: 'job-expand-all text-button',
          text: anyClosed ? 'expand all workers' : 'collapse all',
          attrs: { type: 'button', 'data-key': 'jobtoggle-' + job.name },
          onclick: function (e) {
            if (e && e.stopPropagation) e.stopPropagation();
            // Recompute live (not from the captured closure): morph can reuse this
            // node and keep an older listener, so decide from current state at click.
            var keysNow = [];
            job.runs.forEach(function (run) {
              keysNow.push('r:' + run.id);
              (run.tasks || []).forEach(function (task, ti) {
                keysNow.push(run.id + '::' + taskKey(task, ti));
              });
            });
            var closedNow = keysNow.some(function (k) {
              return k.indexOf('::') >= 0 ? !state.expandedWorkers.has(k) : !state.expanded.has(k);
            });
            keysNow.forEach(function (k) {
              if (k.indexOf('::') >= 0) {
                if (closedNow) state.expandedWorkers.set(k, true);
                else state.expandedWorkers.delete(k);
              } else {
                if (closedNow) state.expanded.set(k, true);
                else state.expanded.delete(k);
              }
            });
            if (closedNow) {
              // one call each covers all newly-added keys (the pollers self-iterate the map)
              fetchExpandedTranscripts();
              fetchExpandedWorkerLogs();
              fetchLiveModels();
            }
            render();
          },
        }));
        body.appendChild(metaRow);

        // newest round on top, labelled ROUND N (N = chronological round number)
        job.runs.slice().reverse().forEach(function (run, idx) {
          body.appendChild(renderRound(run, job.runs.length - idx));
        });
        group.appendChild(body);
      }

      wrapper.appendChild(group);
    });

    return wrapper;
  }

  /** Level 2 — a single round (one run). */
  function renderRound(run, roundN) {
    var rKey = 'r:' + run.id;
    var rOpen = isExpanded(rKey);
    var panel = el('div', {
      className: 'round' + (run.isLive ? ' live' : '') + (rOpen ? ' open' : ''),
      attrs: { 'data-key': 'round-' + run.id },
    });

    var header = el('div', {
      className: 'round-head',
      attrs: { role: 'button', tabindex: '0' },
      onclick: function () { toggleExpanded(rKey); },
    });
    header.appendChild(el('span', { className: 'job-caret', text: rOpen ? '▾' : '▸' }));
    header.appendChild(el('span', { className: 'round-label', text: 'ROUND ' + roundN }));
    header.appendChild(el('span', {
      className: 'round-badge' + (run.isLive ? ' live' : ''),
      text: run.isLive ? 'LIVE' : 'DONE',
    }));
    var pct = run.total > 0 ? (run.done / run.total * 100) : 0;
    var bar = el('span', { className: 'round-bar' });
    bar.appendChild(el('span', {
      className: run.fail > 0 ? 'has-fail' : '',
      style: 'width:' + pct.toFixed(0) + '%',
    }));
    header.appendChild(bar);
    header.appendChild(el('span', { className: 'round-done', text: run.done + '/' + run.total }));
    header.appendChild(el('span', { className: 'round-ago', text: relativeAgo(run.startedAt) }));
    var ft = run.feederTotals;
    header.appendChild(el('span', {
      className: 'round-tokens',
      text: formatTokens(ft ? ft.total_tokens : run.tokens),
    }));
    panel.appendChild(header);

    if (rOpen) {
      panel.appendChild(renderWorkerTable(run));
    }
    return panel;
  }

  /** Level 3 — the worker table for one round. */
  function renderWorkerTable(run) {
    var wrap = el('div', { className: 'worker-table' });

    var head = el('div', { className: 'worker-thead', attrs: { 'data-key': 'thead-' + run.id } });
    ['', 'WORKER', 'MODEL', 'TOKENS', 'LATENCY', 'SCORE', 'LAST CHECK'].forEach(function (h) {
      head.appendChild(el('span', { text: h }));
    });
    wrap.appendChild(head);

    run.tasks.forEach(function (task, ti) {
      var key = taskKey(task, ti);
      var compositeKey = run.id + '::' + key;
      var kind = taskKind(task);
      var expanded = state.expandedWorkers.has(compositeKey);

      var rowWrap = el('div', {
        className: 'worker-rowwrap ' + kind + (expanded ? ' expanded' : ''),
        attrs: { 'data-key': 'worker-' + key },
      });

      var row = el('div', {
        className: 'worker-row',
        attrs: { role: 'button', tabindex: '0' },
        onclick: function () { toggleWorker(compositeKey); },
      });
      row.appendChild(el('span', { className: 'w-icon ' + kind, text: kindIcon(kind) }));
      row.appendChild(el('span', { className: 'w-name ' + (kind === 'fail' ? 'fail' : ''), text: task.name || key }));
      row.appendChild(el('span', { className: 'w-model', text: servedModel(task, compositeKey) }));
      row.appendChild(el('span', { className: 'w-tokens', text: task.tokens ? formatTokens(task.tokens) : '' }));
      row.appendChild(el('span', { className: 'w-latency', text: formatLatency(taskLatency(task)) }));
      // SCORE = the orchestrator's grade (0..1 persisted by quality_feed.py, shown /10).
      var grade = task.quality_score;
      var hasGrade = (typeof grade === 'number' && !isNaN(grade));
      row.appendChild(el('span', {
        className: 'w-score ' + (hasGrade ? (grade >= 0.7 ? 'good' : 'poor') : 'none'),
        text: hasGrade ? (grade * 10).toFixed(1) : '—',
        attrs: hasGrade ? { title: 'Orchestrator grade' + (task.graded_by ? ' — ' + task.graded_by : '') } : {},
      }));
      row.appendChild(el('span', { className: 'w-note', text: lastCheckNote(task) }));
      rowWrap.appendChild(row);

      if (expanded) {
        rowWrap.appendChild(renderWorkerDetail(run, task, compositeKey));
      }
      wrap.appendChild(rowWrap);
    });

    return wrap;
  }

  // ── Worker detail: BRIEF / ACTIONS / OUTPUT tabs ─────────────────────────

  function currentTab(compositeKey) {
    return state.workerTabs.get(compositeKey) || 'actions';
  }

  /** Turn epoch-ms into HH:MM:SS for the ACTIONS timeline. */
  function turnTime(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    return d.toTimeString().slice(0, 8);
  }

  /** One transcript turn → an ACTIONS grid row {time, role, text, cls}. */
  function turnToRow(turn) {
    var role = turn.role === 'orchestrator' ? 'ORCH' : 'WORKER';
    var text = '';
    if (turn.role === 'orchestrator') {
      text = turn.kind === 'retry_reply'
        ? '↩ sent it back (previous attempt failed): ' + String(turn.text || '')
        : String(turn.text || '');
    } else if (turn.kind === 'text') {
      text = String(turn.text || '');
    } else if (turn.kind === 'tool') {
      var inp = turn.input;
      var title = (inp && typeof inp === 'object') ? String(inp.filePath || inp.command || inp.path || inp.pattern || '') : '';
      text = '🔧 ' + (turn.tool || 'tool') + (title ? ' · ' + title : '');
    } else if (turn.kind === 'step') {
      var tok = turn.tokens && turn.tokens.total ? formatTokens(turn.tokens.total) + ' tok' : '';
      text = '· ' + (turn.reason || 'step') + (tok ? ' · ' + tok : '');
    } else if (turn.kind === 'error') {
      text = '⚠ ' + (turn.message || turn.name || 'error');
    } else {
      text = String(turn.text || '');
    }
    return { time: turnTime(turn.t_start), role: role, text: text, kind: turn.kind || '' };
  }

  /** Render the ACTIONS tab: transcript turns as time | ROLE | text rows. */
  function renderActionsTab(compositeKey) {
    var box = el('div', { className: 'wd-actions', attrs: { 'data-transcript-key': compositeKey } });
    var transcript = state.transcripts.get(compositeKey);
    var attempts = transcript && Array.isArray(transcript.attempts) ? transcript.attempts : [];
    if (!attempts.length) {
      box.appendChild(el('div', {
        className: 'wd-empty',
        text: transcript && transcript.status === 'error' ? 'Transcript unavailable.' : 'Waiting for the conversation…',
      }));
      return box;
    }
    attempts.forEach(function (att) {
      if (attempts.length > 1) {
        box.appendChild(el('div', {
          className: 'wd-attempt-sep',
          attrs: { 'data-outcome': att.outcome || '' },
          text: 'ATTEMPT ' + att.n + ' · ' + (att.outcome || '') + (att.rc != null ? ' · rc=' + att.rc : ''),
        }));
      }
      (att.turns || []).forEach(function (turn) {
        var r = turnToRow(turn);
        var rowEl = el('div', { className: 'wd-turn', attrs: { 'data-kind': r.kind } });
        rowEl.appendChild(el('span', { className: 'wd-time', text: r.time }));
        rowEl.appendChild(el('span', { className: 'wd-role ' + (r.role === 'ORCH' ? 'orch' : 'worker'), text: r.role }));
        rowEl.appendChild(el('span', { className: 'wd-text', text: r.text }));
        box.appendChild(rowEl);
      });
    });
    return box;
  }

  /** Render the OUTPUT tab: check command, rc chip, output tail, file links, live log. */
  function renderOutputTab(run, task, compositeKey) {
    var box = el('div', { className: 'wd-output' });

    var checkRow = el('div', { className: 'wd-check-row' });
    checkRow.appendChild(el('span', { className: 'wd-label', text: 'CHECK' }));
    checkRow.appendChild(el('span', { className: 'wd-check', text: task.check || '(no check)' }));
    var rc = task.check_returncode;
    var rcText = rc == null ? '—' : String(rc);
    var rcCls = rc === 0 ? 'good' : (rc == null ? 'none' : 'bad');
    checkRow.appendChild(el('span', { className: 'wd-rc ' + rcCls, text: 'rc=' + rcText }));
    box.appendChild(checkRow);

    var tail = task.check_output_tail;
    var tailText = Array.isArray(tail) ? tail.join('\n') : String(tail == null ? '' : tail);
    box.appendChild(el('pre', {
      className: 'wd-output-block',
      text: tailText.trim() || '(check not yet run)',
    }));

    var links = el('div', { className: 'wd-links' });
    if (task.taskdir) {
      links.appendChild(el('a', { text: 'open taskdir', attrs: { href: 'file://' + task.taskdir, target: '_blank', rel: 'noopener' } }));
      links.appendChild(el('span', { className: 'wd-sep', text: ' · ' }));
    }
    if (task.log_path) {
      links.appendChild(el('a', { text: 'worker.log', attrs: { href: 'file://' + task.log_path, target: '_blank', rel: 'noopener' } }));
    }
    if (links.childNodes.length) box.appendChild(links);

    // Raw live log — escape hatch, collapsed. Seeded from the embedded tail so it is
    // never blank (worker.log files live in /tmp and can be reaped; the run JSON keeps
    // a tail). The live poller targets [data-log-key] and streams while running.
    var seed = stripAnsi(task.log_tail_full || task.log_tail || '');
    var logDetails = el('details', { className: 'wd-rawlog', attrs: { 'data-key': 'rawlog-' + compositeKey } });
    logDetails.appendChild(el('summary', { text: 'raw worker log' }));
    logDetails.appendChild(el('pre', {
      className: 'worker-log',
      attrs: { 'data-log-key': compositeKey },
      text: seed || 'Loading log...',
    }));
    box.appendChild(logDetails);

    return box;
  }

  /** Render expanded worker detail: tab bar + active tab panel. */
  function renderWorkerDetail(run, task, compositeKey) {
    var detail = el('div', { className: 'worker-detail' });
    var tab = currentTab(compositeKey);

    var tabbar = el('div', { className: 'wd-tabs' });
    ['brief', 'actions', 'output'].forEach(function (t) {
      tabbar.appendChild(el('button', {
        className: 'wd-tab' + (tab === t ? ' active' : ''),
        text: t.toUpperCase(),
        attrs: { type: 'button', 'data-key': 'tab-' + compositeKey + '-' + t },
        onclick: function (e) {
          if (e && e.stopPropagation) e.stopPropagation();
          state.workerTabs.set(compositeKey, t);
          render();
        },
      }));
    });
    detail.appendChild(tabbar);

    if (tab === 'brief') {
      detail.appendChild(el('pre', { className: 'wd-brief', text: task.spec || task.spec_short || '(no spec recorded)' }));
    } else if (tab === 'output') {
      detail.appendChild(renderOutputTab(run, task, compositeKey));
    } else {
      detail.appendChild(renderActionsTab(compositeKey));
    }

    return detail;
  }

  /** Toggle worker expansion. */
  function toggleWorker(compositeKey) {
    if (state.expandedWorkers.has(compositeKey)) {
      state.expandedWorkers.delete(compositeKey);
    } else {
      state.expandedWorkers.set(compositeKey, true);
      // fetch immediately so the conversation + log show at once, not on the next poll
      fetchExpandedTranscripts();
      fetchExpandedWorkerLogs();
      fetchLiveModels();
    }
    render();
  }

  // ── Live conversation (agent ↔ orchestrator transcript) ───────────────────

  /** Fetch the parsed transcript for each expanded worker (running = poll; else once). */
  function fetchExpandedTranscripts() {
    state.expandedWorkers.forEach(function (_v, compositeKey) {
      var parts = compositeKey.split('::');
      var rid = parts[0], tkey = parts[1];
      var run = state.runs.find(function (r) { return r.id === rid; });
      if (!run) return;
      var task = run.tasks.find(function (t, ti) { return taskKey(t, ti) === tkey; });
      if (!task) return;
      var kind = taskKind(task);
      var running = (kind === 'working' || kind === 'retry');
      // finished + already loaded → skip; running → poll every tick
      if (!running && state.transcripts.get(compositeKey) && state.transcripts.get(compositeKey).__done) return;
      fetch(apiUrl('/transcript/' + encodeURIComponent(rid) + '/' + encodeURIComponent(tkey)), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
          if (!running) data.__done = true;
          var prev = state.transcripts.get(compositeKey);
          // only re-render if the turn count changed (avoid pointless churn/scroll jumps)
          var changed = !prev || turnCount(prev) !== turnCount(data);
          state.transcripts.set(compositeKey, data);
          if (changed) render();
        })
        .catch(function () {});
    });
  }

  function turnCount(t) {
    if (!t || !Array.isArray(t.attempts)) return 0;
    return t.attempts.reduce(function (n, a) { return n + (a.turns ? a.turns.length : 0); }, 0);
  }

  /** Fetch the REAL served model for each expanded worker from /live-model (running = poll;
   * finished = once). This is what surfaces the actual feeder-served model on the wall even
   * for runs that were never post-run enriched (e.g. launched outside the ringer ritual). */
  function fetchLiveModels() {
    liveModelTargets().forEach(function (compositeKey) {
      var parts = compositeKey.split('::');
      var rid = parts[0], tkey = parts[1];
      var run = state.runs.find(function (r) { return r.id === rid; });
      if (!run) return;
      var task = run.tasks.find(function (t, ti) { return taskKey(t, ti) === tkey; });
      if (!task) return;
      // Already resolved to a real served model → don't re-poll a finished row.
      var have = state.liveModels.get(compositeKey);
      if (have && have.__done) return;
      var kind = taskKind(task);
      var running = (kind === 'working' || kind === 'retry');
      var prev = state.liveModels.get(compositeKey);
      // finished + already resolved to a real served model → skip; running → keep polling
      if (!running && prev && prev.__done) return;
      fetch(apiUrl('/live-model/' + encodeURIComponent(rid) + '/' + encodeURIComponent(tkey)), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
          if (!running && servedFromArray(data.served)) data.__done = true;
          var before = prev ? servedFromArray(prev.served) : '';
          var after = servedFromArray(data.served);
          state.liveModels.set(compositeKey, data);
          if (before !== after) render();
        })
        .catch(function () {});
    });
  }

  // ── Drawers: FEED + ARTIFACTS slide-overs ────────────────────────────────

  /** Aggregate task events across runs for the feed drawer (+ topbar count). */
  function collectFeedEvents() {
    var events = [];
    state.runs.forEach(function (run) {
      run.tasks.forEach(function (task, ti) {
        var kind = taskKind(task);
        if (kind === 'waiting') return; // skip unstarted tasks
        events.push({
          time: parseTime(task.updatedAt || task.startedAt || run.startedAt),
          run: run.runName || run.label,
          task: task.name || taskKey(task, ti),
          kind: kind,
          text: taskStateText(kind),
          activity: lastCheckNote(task),
        });
      });
    });
    events.sort(function (a, b) { return b.time - a.time; });
    return events.slice(0, 50);
  }

  function openDrawer(which) {
    state.drawer = which;
    var scrim = document.getElementById('drawer-scrim');
    var drawer = document.getElementById('drawer');
    var feedBody = document.getElementById('drawer-feed');
    var artBody = document.getElementById('drawer-artifact');
    var title = document.getElementById('drawer-title');
    if (!drawer) return;
    scrim.hidden = false;
    drawer.hidden = false;
    if (which === 'feed') {
      title.textContent = 'ACTIVITY FEED';
      feedBody.hidden = false;
      artBody.hidden = true;
      updateFeedDrawer();
    } else {
      title.textContent = 'ARTIFACTS';
      feedBody.hidden = true;
      artBody.hidden = false;
      updateArtifactDrawer();
    }
  }

  function closeDrawer() {
    state.drawer = null;
    var scrim = document.getElementById('drawer-scrim');
    var drawer = document.getElementById('drawer');
    if (scrim) scrim.hidden = true;
    if (drawer) drawer.hidden = true;
  }

  function toggleDrawer(which) {
    if (state.drawer === which) closeDrawer();
    else openDrawer(which);
  }

  function updateFeedDrawer() {
    var host = document.getElementById('drawer-feed');
    if (!host) return;
    var wrapper = el('div');
    var events = state.feedEvents;
    if (!events.length) {
      wrapper.appendChild(el('div', { className: 'empty-state', text: 'No activity yet.', attrs: { 'data-key': 'feed-empty' } }));
    }
    events.forEach(function (evt, i) {
      var card = el('div', {
        className: 'feed-card ' + evt.kind,
        attrs: { 'data-key': 'feed-' + i },
      });
      var head = el('div', { className: 'feed-card-head' });
      head.appendChild(el('span', { className: 'feed-icon ' + evt.kind, text: kindIcon(evt.kind) }));
      head.appendChild(el('span', { className: 'feed-job', text: evt.run }));
      head.appendChild(el('span', { className: 'feed-verdict ' + evt.kind, text: evt.text.toUpperCase() }));
      head.appendChild(el('span', { className: 'feed-ago', text: relativeAgo(evt.time) }));
      card.appendChild(head);
      card.appendChild(el('div', {
        className: 'feed-msg',
        text: evt.task + (evt.activity ? ' · ' + evt.activity : ''),
      }));
      wrapper.appendChild(card);
    });
    morphChildren(host, wrapper);
  }

  function updateArtifactDrawer() {
    var picker = document.getElementById('artifact-picker');
    var versionPicker = document.getElementById('artifact-version');
    var preview = document.getElementById('artifact-preview');
    var openLink = document.getElementById('artifact-open');
    if (!picker) return;

    // Populate artifact picker
    picker.innerHTML = '';
    var defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = state.artifacts.length ? '-- Select artifact --' : 'No artifacts';
    picker.appendChild(defaultOpt);
    state.artifacts.forEach(function (art) {
      var opt = document.createElement('option');
      opt.value = art.name;
      opt.textContent = art.name + ' (' + art.state + ')';
      if (art.name === state.selectedArtifact) opt.selected = true;
      picker.appendChild(opt);
    });
    if (state.selectedArtifact) picker.value = state.selectedArtifact;

    var selected = state.artifacts.find(function (a) { return a.name === state.selectedArtifact; });

    // Version picker (latest first)
    versionPicker.innerHTML = '';
    var versions = selected && Array.isArray(selected.versions) ? selected.versions : [];
    versions.slice().reverse().forEach(function (v, ri) {
      var vi = versions.length - 1 - ri; // original index
      var opt = document.createElement('option');
      opt.value = String(vi);
      opt.textContent = 'v' + (vi + 1) + (vi === versions.length - 1 ? ' (latest)' : '');
      versionPicker.appendChild(opt);
    });
    var selIdx = state.artifactVersion !== '' ? Number(state.artifactVersion) : versions.length - 1;
    if (versions.length) versionPicker.value = String(Math.min(Math.max(selIdx, 0), versions.length - 1));

    var ver = versions.length ? versions[Math.min(Math.max(selIdx, 0), versions.length - 1)] : null;
    if (preview) {
      if (ver && ver.url) {
        var have = preview.querySelector('iframe');
        if (!have || have.getAttribute('src') !== ver.url) {
          preview.innerHTML = '<iframe src="' + ver.url + '" sandbox="allow-scripts allow-same-origin"></iframe>';
        }
      } else if (selected) {
        preview.innerHTML = '<span>No preview available</span>';
      } else {
        preview.innerHTML = '<span>Select an artifact to preview</span>';
      }
    }
    if (openLink) {
      if (ver && ver.url) { openLink.hidden = false; openLink.href = ver.url; }
      else openLink.hidden = true;
    }

    if (!picker._wired) {
      picker._wired = true;
      picker.addEventListener('change', function (e) {
        state.selectedArtifact = e.target.value;
        state.artifactVersion = '';
        updateArtifactDrawer();
      });
      versionPicker.addEventListener('change', function (e) {
        state.artifactVersion = e.target.value;
        updateArtifactDrawer();
      });
    }
  }

  function setupDrawers() {
    var feedBtn = document.getElementById('feed-btn');
    var artBtn = document.getElementById('artifacts-btn');
    var closeBtn = document.getElementById('drawer-close');
    var scrim = document.getElementById('drawer-scrim');
    if (feedBtn) feedBtn.addEventListener('click', function () { toggleDrawer('feed'); });
    if (artBtn) artBtn.addEventListener('click', function () { toggleDrawer('artifact'); });
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    if (scrim) scrim.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.drawer) closeDrawer();
    });
  }

  // ── Analytics ────────────────────────────────────────────────────────────

  var analyticsCharts = {};  // track Chart.js instances for cleanup

  /** Look up a served model's recent latency from the feeder canon (instance match). */
  function servedLatency(servedModel) {
    var parts = String(servedModel || '').split('/');
    var platform = parts.shift(); var modelId = parts.join('/');
    var canon = state.canon || [];
    for (var i = 0; i < canon.length; i++) {
      var ins = canon[i].instances || [];
      for (var j = 0; j < ins.length; j++) {
        if (ins[j].platform === platform && ins[j].model_id === modelId) return numberOrZero(ins[j].recent_latency_ms);
      }
    }
    return 0;
  }

  function getModelsArray() {
    // Prefer Ringer's REAL served-model x task-class outcomes (/api/usage) — what the
    // swarm actually ran, keyed on the model that truly served + the real wire-class.
    if (state.usage && state.usage.length) {
      return state.usage.map(function (u) {
        return {
          model: u.served_model,
          task_class: u.task_class,
          quality: numberOrZero(u.pass_rate),
          first_try_pass: numberOrZero(u.first_try_pass_rate),
          latency: servedLatency(u.served_model),
          requests: numberOrZero(u.tasks),
          tokens: numberOrZero(u.tokens),
        };
      });
    }
    // Fallback: legacy routed-slug scoreboard (before any run is feeder-enriched).
    if (!state.modelsData) return [];
    var source = Array.isArray(state.modelsData) ? state.modelsData : (state.modelsData.models || state.modelsData.scoreboard || state.modelsData.rollup || []);
    var normalized = [];
    source.forEach(function (row) {
      var breakdowns = Array.isArray(row.task_types) ? row.task_types : [row];
      breakdowns.forEach(function (item) {
        normalized.push({
          model: row.model || row.model_id || row.name || 'unknown',
          task_class: item.task_type || row.task_type || 'all tasks',
          quality: numberOrZero(item.pass_rate || row.pass_rate),
          first_try_pass: numberOrZero(item.first_try_pass_rate || row.first_try_pass_rate),
          latency: numberOrZero(item.median_duration_ms || row.median_duration_ms),
          requests: numberOrZero(item.tasks || row.tasks),
          tokens: numberOrZero(row.median_tokens)
        });
      });
    });
    return normalized;
  }

  /** Get theme-aware chart colors. */
  function chartColors() {
    var t = state.theme;
    return {
      text: t === 'h4' ? '#00ff41' : t === 'light' ? '#333' : '#c5ccd6',
      grid: t === 'h4' ? 'rgba(0,255,65,0.08)' : t === 'light' ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)',
      accent: t === 'h4' ? '#00ff41' : '#35d0ff',
      pass: t === 'h4' ? '#00ff41' : '#2ee89a',
      fail: t === 'h4' ? '#ff1744' : '#ff4f6e',
      working: t === 'h4' ? '#ffea00' : '#f5b731',
      palette: t === 'h4'
        ? ['#00ff41', '#ff2fd2', '#ffea00', '#a8f0b8', '#0a7d2b', '#00e650']
        : ['#35d0ff', '#2ee89a', '#f5b731', '#ff4f6e', '#a78bfa', '#f472b6'],
    };
  }

  /** Destroy all existing Chart.js instances. */
  function destroyCharts() {
    Object.keys(analyticsCharts).forEach(function (k) {
      if (analyticsCharts[k]) { analyticsCharts[k].destroy(); delete analyticsCharts[k]; }
    });
  }

  /** Average orchestrator grade (0..1) per served model, computed from run JSONs. */
  function gradesByServedModel() {
    var acc = {}; // model → { sum, n }
    state.runs.forEach(function (run) {
      run.tasks.forEach(function (task) {
        if (typeof task.quality_score !== 'number' || isNaN(task.quality_score)) return;
        var m = servedModel(task, null);
        if (!m) return;
        if (!acc[m]) acc[m] = { sum: 0, n: 0 };
        acc[m].sum += task.quality_score;
        acc[m].n++;
      });
    });
    var out = {};
    Object.keys(acc).forEach(function (m) { out[m] = acc[m].sum / acc[m].n; });
    return out;
  }

  /** All orchestrator grades across runs (for the analytics KPI). */
  function allGrades() {
    var grades = [];
    state.runs.forEach(function (run) {
      run.tasks.forEach(function (task) {
        if (typeof task.quality_score === 'number' && !isNaN(task.quality_score)) grades.push(task.quality_score);
      });
    });
    return grades;
  }

  // ── Models page: wire-class scoreboard ─────────────────────────────────────

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Reserved fixture names (docs/TAXONOMY.md) — excluded from every ranking.
  var FIXTURE_RE = /^(mock-|proven-|fixture|test-model)/i;

  /** Derive a display lab from a served-model slug. Unverified → shown with "?". */
  function labFromServed(served) {
    var parts = String(served || '').split('/');
    // platform/author/model → author; platform/model → platform
    var lab = parts.length >= 3 ? parts[1] : (parts[0] || '');
    var known = {
      'moonshotai': 'Moonshot AI', 'mistralai': 'Mistral AI', 'nvidia': 'NVIDIA',
      'deepseek-ai': 'DeepSeek', 'deepseek': 'DeepSeek', 'openai': 'OpenAI',
      'meta-llama': 'Meta', 'qwen': 'Alibaba', 'z-ai': 'Z.ai', 'zai-org': 'Z.ai',
      'google': 'Google', 'anthropic': 'Anthropic', 'x-ai': 'xAI', 'poolside': 'Poolside',
    };
    var key = lab.toLowerCase();
    return known[key] || (lab ? lab + ' ?' : '?');
  }

  function renderModelsPage() {
    var host = document.getElementById('models-content');
    if (!host) return;

    var usage = (state.usage || []).filter(function (u) {
      var name = String(u.served_model || '').split('/').pop();
      return !FIXTURE_RE.test(name) && !FIXTURE_RE.test(u.served_model || '');
    });

    // Classes actually present in the eval log (never hardcoded).
    var classes = [];
    usage.forEach(function (u) {
      if (u.task_class && classes.indexOf(u.task_class) < 0) classes.push(u.task_class);
    });
    classes.sort();

    var cls = state.modelsClass || 'all';
    var chips = ['all'].concat(classes).map(function (c) {
      var label = c === 'all' ? 'ALL' : c.replace(/_/g, ' ').toUpperCase();
      return '<button class="class-chip' + (c === cls ? ' active' : '') + '" data-class="' + esc(c) + '" type="button">' + esc(label) + '</button>';
    }).join('');

    // Aggregate rows for the selected class ('all' = merge across classes per model).
    var rowsByModel = {};
    usage.forEach(function (u) {
      if (cls !== 'all' && u.task_class !== cls) return;
      var m = u.served_model;
      if (!rowsByModel[m]) rowsByModel[m] = { model: m, tasks: 0, passes: 0, firstTry: 0, tokens: 0 };
      rowsByModel[m].tasks += numberOrZero(u.tasks);
      rowsByModel[m].passes += numberOrZero(u.passes);
      rowsByModel[m].firstTry += numberOrZero(u.first_try);
      rowsByModel[m].tokens += numberOrZero(u.tokens);
    });
    var grades = gradesByServedModel();
    var rows = Object.keys(rowsByModel).map(function (m) {
      var r = rowsByModel[m];
      var grade = grades[m]; // 0..1 or undefined
      return {
        model: m,
        lab: labFromServed(m),
        harness: 'OpenCode',
        runs: r.tasks,
        pass: r.passes,
        fail: r.tasks - r.passes,
        firstTry: r.tasks ? (r.firstTry / r.tasks * 100) : 0,
        score: (typeof grade === 'number') ? grade * 10 : null,
        sortScore: (typeof grade === 'number') ? grade * 10 : (r.tasks ? (r.passes / r.tasks) * 10 : 0),
        latency: servedLatency(m),
        tokTask: r.tasks ? r.tokens / r.tasks : 0,
      };
    });
    rows.sort(function (a, b) { return b.sortScore - a.sortScore; });

    var html = '<div class="class-chips">' +
      '<span class="class-chips-label">Prompt type</span>' + chips + '</div>';

    if (!rows.length) {
      html += '<div class="glass score-table"><div class="score-empty">No runs logged for this prompt type yet.</div></div>';
    } else {
      html += '<div class="glass score-table"><div class="table-scroll">';
      html += '<div class="score-grid score-grid-head">' +
        '<span>RANK</span><span>MODEL</span><span>LAB</span><span>HARNESS</span><span>RUNS</span>' +
        '<span>PASS</span><span>FIRST-TRY</span><span>AVG SCORE</span><span>LATENCY</span><span>TOK/TASK</span></div>';
      rows.forEach(function (r, i) {
        var scoreTxt = r.score != null ? r.score.toFixed(1) : '—';
        var scoreCls = r.score == null ? 'none' : (r.score >= 8 ? 'good' : r.score >= 6.5 ? 'ok' : 'poor');
        var scorePct = r.score != null ? Math.min(100, r.score * 10).toFixed(0) : '0';
        html += '<div class="score-grid score-grid-row' + (i === 0 ? ' top' : '') + '">' +
          '<span class="sc-rank' + (i === 0 ? ' top' : '') + '">#' + (i + 1) + '</span>' +
          '<span class="sc-model">' + esc(r.model) + '</span>' +
          '<span class="sc-lab">' + esc(r.lab) + '</span>' +
          '<span class="sc-harness">' + esc(r.harness) + '</span>' +
          '<span>' + r.runs + '</span>' +
          '<span><span class="sc-pass">' + r.pass + '</span><span class="sc-slash">/</span><span class="sc-fail">' + r.fail + '</span></span>' +
          '<span>' + r.firstTry.toFixed(0) + '%</span>' +
          '<span class="sc-score-cell"><span class="sc-score ' + scoreCls + '">' + scoreTxt + '</span>' +
            '<span class="sc-score-bar"><span class="' + scoreCls + '" style="width:' + scorePct + '%"></span></span></span>' +
          '<span>' + (r.latency ? formatLatency(r.latency) : '—') + '</span>' +
          '<span>' + (r.tokTask ? formatTokens(r.tokTask) : '—') + '</span>' +
          '</div>';
      });
      html += '</div></div>';
    }
    html += '<div class="score-footnote">Lab &ne; harness &ne; plan (docs/TAXONOMY.md). Labs derived from the served slug show with ? until identity is verified. ' +
      'Reserved fixture names (proven-model, mock-model, &hellip;) are excluded from every ranking. ' +
      'AVG SCORE is the orchestrator’s grade (&mdash; until a run is graded); rank falls back to pass rate when ungraded.</div>';

    host.innerHTML = html;
    host.querySelectorAll('.class-chip').forEach(function (b) {
      b.addEventListener('click', function () { state.modelsClass = b.dataset.class; renderModelsPage(); });
    });
  }

  /** Build all analytics charts and summary KPIs. */
  function buildAnalytics() {
    var models = getModelsArray();
    var statusEl = document.getElementById('analytics-data-status');
    if (statusEl) statusEl.textContent = models.length
      ? (state.usage && state.usage.length ? 'Ringer served-model outcomes (real, by class)' : 'Legacy routed-slug scoreboard (no enriched runs yet)')
      : 'No run outcomes yet';
    if (models.length === 0) return;

    var C = chartColors();

    // --- Aggregate data ---
    var uniqueModels = [];
    var modelMap = {};  // model -> { quality[], pass[], latency[], requests, tokens }
    var taskClassCounts = {};
    var totalRequests = 0, totalTokens = 0, totalFirstTry = 0;

    models.forEach(function (m) {
      var name = m.model || m.model_id || m.name || 'unknown';
      var tc = m.task_class || 'unknown';
      if (!modelMap[name]) {
        modelMap[name] = { quality: [], pass: [], latency: [], requests: 0, tokens: 0 };
        uniqueModels.push(name);
      }
      modelMap[name].quality.push(numberOrZero(m.quality));
      modelMap[name].pass.push(numberOrZero(m.first_try_pass));
      modelMap[name].latency.push(numberOrZero(m.latency));
      modelMap[name].requests += numberOrZero(m.requests);
      modelMap[name].tokens += numberOrZero(m.tokens);
      totalRequests += numberOrZero(m.requests);
      totalTokens += numberOrZero(m.tokens);
      totalFirstTry += numberOrZero(m.first_try_pass) * numberOrZero(m.requests);
      taskClassCounts[tc] = (taskClassCounts[tc] || 0) + numberOrZero(m.requests);
    });

    // Compute averages per model
    var avgQuality = [], avgPass = [], avgLatency = [], reqCounts = [], tokPerTask = [];
    uniqueModels.forEach(function (name) {
      var d = modelMap[name];
      var avg = function (arr) { return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length; };
      avgQuality.push(+(avg(d.quality) * 100).toFixed(1));
      avgPass.push(+(avg(d.pass) * 100).toFixed(1));
      avgLatency.push(+avg(d.latency).toFixed(0));
      reqCounts.push(d.requests);
      tokPerTask.push(d.requests ? Math.round(d.tokens / d.requests) : 0);
    });

    // --- Summary KPIs (per handoff §7: runs, first-try, avg orch score, avg tok/task) ---
    var summaryEl = document.getElementById('analytics-summary');
    if (summaryEl) {
      summaryEl.innerHTML = '';
      var jobsCount = groupJobs().length;
      var grades = allGrades();
      var avgGrade = grades.length ? (grades.reduce(function (a, b) { return a + b; }, 0) / grades.length) * 10 : null;
      var kpis = [
        { label: 'Total Runs', value: String(state.runs.length || totalRequests), sub: jobsCount + ' jobs' },
        { label: 'First-Try Pass', value: totalRequests ? (totalFirstTry / totalRequests * 100).toFixed(0) + '%' : '—', sub: 'all models' },
        { label: 'Avg Orch Score', value: avgGrade != null ? avgGrade.toFixed(1) : '—', sub: avgGrade != null ? 'of 10 · ' + grades.length + ' graded' : 'no graded runs yet' },
        { label: 'Avg Tok/Task', value: totalRequests ? formatTokens(totalTokens / totalRequests) : '—', sub: 'weighted' },
      ];
      kpis.forEach(function (k) {
        var card = document.createElement('div');
        card.className = 'analytics-kpi';
        card.innerHTML = '<div class="ak-label">' + k.label + '</div>' +
          '<div class="ak-line"><span class="ak-value">' + k.value + '</span>' +
          '<span class="ak-sub">' + k.sub + '</span></div>';
        summaryEl.appendChild(card);
      });
    }

    // --- Chart defaults ---
    var chartDefaults = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: C.text, font: { size: 11 } } },
      },
      scales: {
        x: { ticks: { color: C.text, font: { size: 10 } }, grid: { color: C.grid } },
        y: { ticks: { color: C.text, font: { size: 10 } }, grid: { color: C.grid } },
      },
    };

    destroyCharts();

    // --- Chart 1: Quality Score Bar ---
    var ctx1 = document.getElementById('chart-quality');
    if (ctx1) {
      analyticsCharts.quality = new Chart(ctx1, {
        type: 'bar',
        data: {
          labels: uniqueModels,
          datasets: [{
            label: 'Avg Quality %',
            data: avgQuality,
            backgroundColor: C.palette.slice(0, uniqueModels.length),
            borderRadius: 2,
            borderSkipped: false,
          }],
        },
        options: Object.assign({}, chartDefaults, {
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: C.text, font: { size: 10 }, maxRotation: 30 }, grid: { display: false } },
            y: { ticks: { color: C.text }, grid: { color: C.grid }, min: 0, max: 100,
              title: { display: true, text: 'Quality %', color: C.text } },
          },
        }),
      });
    }

    // --- Chart 2: First-Try Pass Rate Bar ---
    var ctx2 = document.getElementById('chart-pass-rate');
    if (ctx2) {
      analyticsCharts.passRate = new Chart(ctx2, {
        type: 'bar',
        data: {
          labels: uniqueModels,
          datasets: [{
            label: 'First-Try Pass %',
            data: avgPass,
            backgroundColor: avgPass.map(function (v) {
              return v >= 80 ? C.pass : v >= 60 ? C.working : C.fail;
            }),
            borderRadius: 2,
            borderSkipped: false,
          }],
        },
        options: Object.assign({}, chartDefaults, {
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: C.text, font: { size: 10 }, maxRotation: 30 }, grid: { display: false } },
            y: { ticks: { color: C.text }, grid: { color: C.grid }, min: 0, max: 100,
              title: { display: true, text: 'Pass Rate %', color: C.text } },
          },
        }),
      });
    }

    // --- Chart 3: Latency Bar (horizontal) ---
    var ctx3 = document.getElementById('chart-latency');
    if (ctx3) {
      analyticsCharts.latency = new Chart(ctx3, {
        type: 'bar',
        data: {
          labels: uniqueModels,
          datasets: [{
            label: 'Avg Latency (ms)',
            data: avgLatency,
            backgroundColor: avgLatency.map(function (v) {
              return v <= 2000 ? C.pass : v <= 3500 ? C.working : C.fail;
            }),
            borderRadius: 2,
            borderSkipped: false,
          }],
        },
        options: Object.assign({}, chartDefaults, {
          indexAxis: 'y',
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: C.text }, grid: { color: C.grid },
              title: { display: true, text: 'Latency (ms)', color: C.text } },
            y: { ticks: { color: C.text, font: { size: 10 } }, grid: { display: false } },
          },
        }),
      });
    }

    // --- Chart 4: Request Volume Bar ---
    var ctx4 = document.getElementById('chart-requests');
    if (ctx4) {
      analyticsCharts.requests = new Chart(ctx4, {
        type: 'bar',
        data: {
          labels: uniqueModels,
          datasets: [{
            label: 'Requests',
            data: reqCounts,
            backgroundColor: C.accent,
            borderRadius: 2,
            borderSkipped: false,
          }],
        },
        options: Object.assign({}, chartDefaults, {
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: C.text, font: { size: 10 }, maxRotation: 30 }, grid: { display: false } },
            y: { ticks: { color: C.text }, grid: { color: C.grid },
              title: { display: true, text: 'Requests', color: C.text } },
          },
        }),
      });
    }

    // --- Chart 5: Task Class Doughnut ---
    var ctx5 = document.getElementById('chart-task-dist');
    if (ctx5) {
      var tcLabels = Object.keys(taskClassCounts);
      var tcValues = tcLabels.map(function (k) { return taskClassCounts[k]; });
      analyticsCharts.taskDist = new Chart(ctx5, {
        type: 'doughnut',
        data: {
          labels: tcLabels,
          datasets: [{
            data: tcValues,
            backgroundColor: C.palette.concat(['#6b7a99', '#e2e5ea']).slice(0, tcLabels.length),
            borderWidth: 0,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'right', labels: { color: C.text, font: { size: 11 }, padding: 12 } },
          },
        },
      });
    }

    // --- Chart 6: Radar Comparison (top 3 models) ---
    var ctx6 = document.getElementById('chart-radar');
    if (ctx6) {
      var radarDatasets = uniqueModels.slice(0, 3).map(function (name, idx) {
        var d = modelMap[name];
        var avg = function (arr) { return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length; };
        return {
          label: name,
          data: [
            +(avg(d.quality) * 100).toFixed(0),
            +(avg(d.pass) * 100).toFixed(0),
            +((5000 - avg(d.latency)) / 50).toFixed(0),  // invert latency: lower = better
            +(d.requests / (totalRequests / uniqueModels.length) * 50).toFixed(0),  // normalized volume
          ],
          borderColor: C.palette[idx],
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          pointRadius: 2,
        };
      });
      analyticsCharts.radar = new Chart(ctx6, {
        type: 'radar',
        data: {
          labels: ['Quality', 'Pass Rate', 'Speed', 'Volume'],
          datasets: radarDatasets,
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            r: {
              angleLines: { color: C.grid },
              grid: { color: C.grid },
              pointLabels: { color: C.text, font: { size: 11 } },
              ticks: { display: false },
              suggestedMin: 0,
              suggestedMax: 100,
            },
          },
          plugins: {
            legend: { position: 'bottom', labels: { color: C.text, font: { size: 10 }, boxWidth: 12 } },
          },
        },
      });
    }

    // --- Chart 7: Quality vs Latency Scatter ---
    var ctx7 = document.getElementById('chart-scatter');
    if (ctx7) {
      var scatterDatasets = uniqueModels.map(function (name, idx) {
        return {
          label: name,
          data: models.filter(function (m) { return (m.model || m.model_id) === name; }).map(function (m) {
            return { x: numberOrZero(m.latency), y: numberOrZero(m.quality) * 100, r: Math.sqrt(numberOrZero(m.requests)) * 2 };
          }),
          backgroundColor: C.palette[idx % C.palette.length],
          borderColor: C.palette[idx % C.palette.length],
        };
      });
      analyticsCharts.scatter = new Chart(ctx7, {
        type: 'bubble',
        data: { datasets: scatterDatasets },
        options: Object.assign({}, chartDefaults, {
          plugins: {
            legend: { position: 'bottom', labels: { color: C.text, font: { size: 10 }, boxWidth: 12 } },
            tooltip: { callbacks: {
              label: function (ctx) {
                return ctx.dataset.label + ': ' + ctx.raw.y.toFixed(0) + '% quality, ' + ctx.raw.x + 'ms';
              }
            }},
          },
          scales: {
            x: { ticks: { color: C.text }, grid: { color: C.grid },
              title: { display: true, text: 'Latency (ms)', color: C.text } },
            y: { ticks: { color: C.text }, grid: { color: C.grid }, min: 50, max: 100,
              title: { display: true, text: 'Quality %', color: C.text } },
          },
        }),
      });
    }

    // --- Scoreboard Table ---
    var tableEl = document.getElementById('analytics-table');
    if (tableEl) {
      var html = '<table class="models-table"><thead><tr>' +
        '<th>Model</th><th>Task Class</th><th>Quality</th><th>Latency</th>' +
        '<th>Requests</th><th>First-Try Pass</th><th>Tok/Task</th></tr></thead><tbody>';
      models.forEach(function (m) {
        var q = numberOrZero(m.quality);
        var p = numberOrZero(m.first_try_pass);
        var lat = numberOrZero(m.latency);
        var tpt = m.requests ? numberOrZero(m.tokens) / m.requests : 0;
        var passClass = p >= 0.8 ? 'pass' : p >= 0.6 ? 'working' : 'fail';
        html += '<tr><td><strong>' + esc(m.model || m.model_id || '-') + '</strong></td>' +
          '<td>' + esc(m.task_class || '-') + '</td>' +
          '<td>' + (q * 100).toFixed(0) + '%</td>' +
          '<td>' + (lat ? formatLatency(lat) : '—') + '</td>' +
          '<td>' + (m.requests || 0) + '</td>' +
          '<td class="text-' + passClass + '" style="font-weight:600;">' + (p * 100).toFixed(0) + '%</td>' +
          '<td>' + (tpt ? formatTokens(tpt) : '—') + '</td></tr>';
      });
      html += '</tbody></table>';
      tableEl.innerHTML = html;
    }
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  /** Navigate to a page: 'dashboard' | 'analytics' | 'models' | 'queue' | 'settings'. */
  function navigateTo(page) {
    state.currentPage = page;

    // Toggle nav icon active states
    document.querySelectorAll('.nav-icon').forEach(function (icon) {
      icon.classList.toggle('active', icon.dataset.page === page);
    });

    // Show/hide page panels (remove hidden attr, use display)
    document.querySelectorAll('.page-panel').forEach(function (panel) {
      panel.removeAttribute('hidden');
      panel.style.display = panel.dataset.page === page ? 'block' : 'none';
    });

    // Fetch real feeder catalog + usage on analytics/models visit, then render.
    if (page === 'analytics' || page === 'models') {
      if (!state.canon.length && !state.usage.length && !state.modelsData) {
        fetchModels(); // renders both pages when data lands
      } else if (page === 'models') {
        renderModelsPage();
      } else {
        setTimeout(buildAnalytics, 50); // fresh canvas contexts after show/hide
      }
    }
    if (page === 'queue') fetchQueue();

    render();
  }

  /** Wire up navigation icon click listeners. */
  function setupNavigation() {
    document.querySelectorAll('.nav-icon').forEach(function (icon) {
      icon.addEventListener('click', function () {
        navigateTo(icon.dataset.page || 'dashboard');
      });
    });
  }

  // ── Theme Toggle Setup ───────────────────────────────────────────────────

  function setupThemeToggle() {
    // Wire up both theme buttons (sidebar + topbar)
    var sidebarBtn = document.getElementById('theme-toggle-btn');
    if (sidebarBtn) sidebarBtn.addEventListener('click', cycleTheme);
    var topbarBtn = document.getElementById('theme-label');
    if (topbarBtn) topbarBtn.addEventListener('click', cycleTheme);

    // Keyboard shortcut
    document.addEventListener('keydown', function (e) {
      if (e.key === 'T' && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        cycleTheme();
      }
    });
  }

  // ── Theme Designer ───────────────────────────────────────────────────────

  function hexToRgba(hex, alpha) {
    var value = String(hex || '#06090f').replace('#', '');
    if (value.length === 3) value = value.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(value, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function loadDesigner() {
    try { return JSON.parse(localStorage.getItem('ringside-custom-theme') || '{}'); } catch (_) { return {}; }
  }

  function applyDesigner(settings) {
    if (settings && settings.rain != null) state.rainIntensity = numberOrZero(settings.rain);
    var root = document.documentElement;
    // Colour overrides only when the human actually customised colours —
    // a rain-only tweak must not repaint the current theme's panels.
    if (!settings || !settings.custom || !settings.background) return;
    root.style.setProperty('--ground', settings.background);
    root.style.setProperty('--surface', settings.base === 'white' ? '#ffffff' : settings.base === 'grey' ? '#242830' : '#070707');
    root.style.setProperty('--accent', settings.accent);
    root.style.setProperty('--accent-glow', hexToRgba(settings.accent, .32));
    root.style.setProperty('--glass-bg', hexToRgba(settings.background, Number(settings.overlay || 55) / 100));
    root.style.setProperty('--surface-glass', hexToRgba(settings.background, .78));
    root.style.setProperty('--custom-background-image', settings.image ? 'linear-gradient(' + hexToRgba(settings.background, .40) + ',' + hexToRgba(settings.background, .70) + '), url("' + settings.image + '")' : 'none');
  }

  function setupThemeDesigner() {
    var baseGroup = document.getElementById('designer-base');
    var swatches = document.getElementById('designer-swatches');
    var accent = document.getElementById('designer-accent');
    var background = document.getElementById('designer-background');
    var overlay = document.getElementById('designer-overlay');
    var overlayVal = document.getElementById('designer-overlay-value');
    var rain = document.getElementById('designer-rain');
    var rainVal = document.getElementById('designer-rain-value');
    var dropzone = document.getElementById('designer-dropzone');
    var upload = document.getElementById('designer-upload');
    if (!baseGroup || !accent || !background || !overlay || !rain) return;

    var settings = loadDesigner();
    if (settings.accent) accent.value = settings.accent;
    if (settings.background) background.value = settings.background;
    if (settings.overlay != null) overlay.value = settings.overlay;
    if (settings.rain != null) rain.value = settings.rain;
    applyDesigner(settings);
    syncUI();

    function syncUI() {
      overlayVal.textContent = overlay.value + '%';
      rainVal.textContent = rain.value + '%';
      baseGroup.querySelectorAll('[data-base]').forEach(function (b) {
        b.classList.toggle('active', (settings.base || 'dark') === b.dataset.base);
      });
      if (swatches) swatches.querySelectorAll('.swatch').forEach(function (s) {
        s.classList.toggle('active', (settings.accent || '').toLowerCase() === s.dataset.accent);
      });
    }

    function save(colorTouched) {
      settings = {
        base: settings.base || 'dark',
        accent: accent.value,
        background: background.value,
        overlay: overlay.value,
        rain: rain.value,
        image: settings.image || '',
        // once colours are customised they stay customised until reset
        custom: !!(settings.custom || colorTouched === true),
      };
      localStorage.setItem('ringside-custom-theme', JSON.stringify(settings));
      applyDesigner(settings);
      applyRainIntensity(rain.value);
      syncUI();
    }

    baseGroup.querySelectorAll('[data-base]').forEach(function (b) {
      b.addEventListener('click', function () { settings.base = b.dataset.base; save(true); });
    });
    if (swatches) swatches.querySelectorAll('.swatch').forEach(function (s) {
      s.addEventListener('click', function () { accent.value = s.dataset.accent; save(true); });
    });
    var saveColor = function () { save(true); };
    var saveRain = function () { save(false); };
    [accent, background, overlay].forEach(function (input) {
      input.addEventListener('input', saveColor);
      input.addEventListener('change', saveColor);
    });
    rain.addEventListener('input', saveRain);
    rain.addEventListener('change', saveRain);

    // Background image: dashed drop-zone (click or drop)
    function readImage(file) {
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () { settings.image = reader.result; save(true); };
      reader.readAsDataURL(file);
    }
    if (dropzone && upload) {
      dropzone.addEventListener('click', function () { upload.click(); });
      dropzone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); upload.click(); } });
      dropzone.addEventListener('dragover', function (e) { e.preventDefault(); dropzone.classList.add('over'); });
      dropzone.addEventListener('dragleave', function () { dropzone.classList.remove('over'); });
      dropzone.addEventListener('drop', function (e) {
        e.preventDefault();
        dropzone.classList.remove('over');
        readImage(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
      });
      upload.addEventListener('change', function (e) { readImage(e.target.files && e.target.files[0]); });
    }
    var clearBtn = document.getElementById('designer-clear-image');
    if (clearBtn) clearBtn.addEventListener('click', function () { settings.image = ''; save(true); });

    var reset = document.getElementById('theme-reset');
    if (reset) reset.addEventListener('click', function () {
      localStorage.removeItem('ringside-custom-theme');
      document.documentElement.removeAttribute('style');
      settings = {};
      accent.value = '#35d0ff';
      background.value = '#06090f';
      overlay.value = 55;
      rain.value = 28;
      applyRainIntensity(28);
      syncUI();
    });
  }

  // ── Kirby Easter Egg ─────────────────────────────────────────────────────

  var kirbyTimer = null;

  function setupKirbyListeners() {
    // Shift hold detection: 5 seconds continuous → activate
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Shift') return;
      if (state.kirbyActive || kirbyTimer) return;

      state.kirbyShiftStart = Date.now();
      kirbyTimer = setTimeout(function () {
        state.kirbyActive = true;
        state.kirbyClickCount = 0;
        updateKirbyCursor();
      }, 5000);
    });

    document.addEventListener('keyup', function (e) {
      if (e.key !== 'Shift') return;
      if (kirbyTimer) {
        clearTimeout(kirbyTimer);
        kirbyTimer = null;
      }
      if (state.kirbyActive) {
        state.kirbyActive = false;
        state.kirbyClickCount = 0;
        document.body.style.cursor = '';
      }
    });

    // Click while kirby active → increment, update cursor, maybe dance party
    document.addEventListener('click', function () {
      if (!state.kirbyActive) return;
      state.kirbyClickCount++;
      updateKirbyCursor();

      if (state.kirbyClickCount >= 30 && !state.kirbyDanceActive) {
        startKirbyDanceParty();
      }
    });
  }

  /** Update the cursor to an SVG of the current kirby + color. */
  function updateKirbyCursor() {
    var idx = state.kirbyClickCount % KIRBYS.length;
    var kirby = KIRBYS[idx];
    var color = KIRBY_COLORS[idx];

    // Encode kirby as SVG data URI for cursor
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="24">' +
      '<text x="2" y="18" font-family="monospace" font-size="14" fill="' + color + '">' +
      escapeXml(kirby) +
      '</text></svg>';

    var dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    document.body.style.cursor = 'url("' + dataUri + '") 0 12, auto';
  }

  /** Escape XML special characters. */
  function escapeXml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /** Launch the full-screen KIRBY DANCE PARTY overlay. */
  function startKirbyDanceParty() {
    state.kirbyDanceActive = true;

    var overlay = document.createElement('div');
    overlay.className = 'kirby-dance-overlay';
    overlay.style.cssText =
      'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;' +
      'background:rgba(0,0,0,0.95);display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;cursor:default;';

    // Blinking header
    var header = document.createElement('div');
    header.style.cssText =
      'font-size:3rem;font-weight:bold;font-family:monospace;margin-bottom:2rem;';
    header.textContent = 'KIRBY DANCE PARTY';
    overlay.appendChild(header);

    // Giant bouncing kirby
    var kirbyEl = document.createElement('div');
    kirbyEl.style.cssText =
      'font-size:5rem;font-family:monospace;transition:transform 0.3s;';
    overlay.appendChild(kirbyEl);

    document.body.appendChild(overlay);

    // Animate header color (alternate pink/cyan)
    var blinkState = false;
    var blinkInterval = setInterval(function () {
      blinkState = !blinkState;
      header.style.color = blinkState ? '#ff69b4' : '#00ffff';
    }, 400);

    // Cycle kirby character every 300ms
    var kirbyIdx = 0;
    var cycleInterval = setInterval(function () {
      kirbyIdx = (kirbyIdx + 1) % KIRBYS.length;
      kirbyEl.textContent = KIRBYS[kirbyIdx];
      kirbyEl.style.color = KIRBY_COLORS[kirbyIdx];
      // Bounce effect
      var scale = 1 + Math.sin(kirbyIdx * 0.5) * 0.2;
      kirbyEl.style.transform = 'scale(' + scale + ') rotate(' + (kirbyIdx * 15 - 100) + 'deg)';
    }, 300);

    // Auto-dismiss after 10 seconds
    setTimeout(function () {
      clearInterval(blinkInterval);
      clearInterval(cycleInterval);
      overlay.remove();
      state.kirbyDanceActive = false;
      state.kirbyActive = false;
      state.kirbyClickCount = 0;
      document.body.style.cursor = '';
    }, 10000);
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  function init() {
    var designer = loadDesigner();
    if (designer.rain != null) state.rainIntensity = numberOrZero(designer.rain);
    setTheme(state.theme);
    applyDesigner(designer);
    tickClock();
    setInterval(tickClock, 1000);
    setInterval(fetchRuns, 1000);
    setInterval(fetchLibrary, 2000);
    // Poll the queue only while the Queue page is showing (keeps the board live
    // without a modal open, which would otherwise be clobbered mid-edit).
    setInterval(function () { if (state.currentPage === 'queue' && state.queue.mode === null) fetchQueue(); }, 2500);
    setupQueue();
    setupDrawers();
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      window.__TAURI__.core.invoke('hud_endpoint').then(function (endpoint) { state.apiBase = endpoint; fetchRuns(); fetchLibrary(); }).catch(function () { fetchRuns(); fetchLibrary(); });
    } else { fetchRuns(); fetchLibrary(); }
    setupNavigation();
    setupKirbyListeners();
    setupThemeToggle();
    setupThemeDesigner();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
