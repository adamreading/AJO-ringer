(function () {
  const tauri = window.__TAURI__;
  if (!tauri) return;

  const HUD_BUILD = "b4";
  const EVENT_RUNS = "ringer-runs";
  const topbar = document.querySelector(".topbar");
  const closeButton = document.getElementById("hudClose");
  let latestRuns = [];

  document.documentElement.classList.add("tauri-hud");
  document.title = `Ringside ${HUD_BUILD}`;

  const style = document.createElement("style");
  style.textContent = `
    .tauri-hud, .tauri-hud body {
      height: 100%;
      min-height: 100%;
      overflow: hidden;
      background: transparent;
    }
    .tauri-hud body:before { display: none; }
    .tauri-hud .shell {
      height: 100%;
      border-radius: 14px;
      overflow: hidden;
      background:
        radial-gradient(circle at 50% -20%, rgba(40,215,255,.14), transparent 24rem),
        linear-gradient(180deg, rgba(8,10,15,.94), rgba(13,17,25,.97) 60%, rgba(8,10,15,.94));
      box-shadow: 0 18px 50px rgba(0,0,0,.38);
    }
    .tauri-hud .topbar {
      min-height: 34px;
      padding-top: 5px;
      padding-bottom: 5px;
      background: rgba(5,8,12,.50);
    }
    .tauri-hud .hud-close {
      color: rgba(255,255,255,.72);
    }
    .tauri-hud .hud-close:hover {
      background: #ff5f57;
      color: rgba(60,0,0,.75);
    }
  `;
  document.head.appendChild(style);

  window.addEventListener("error", event => {
    document.title = `Ringside ERR: ${event.message}`.slice(0, 120);
  });

  if (topbar) topbar.setAttribute("data-tauri-drag-region", "");
  if (closeButton) {
    closeButton.title = "Collapse";
    closeButton.setAttribute("aria-label", "Collapse");
    closeButton.setAttribute("data-no-drag", "");
  }

  const currentWindow = tauri.window?.getCurrentWindow?.();
  const noDragSelector = "button, a, input, select, textarea, [data-no-drag]";

  document.addEventListener("mousedown", event => {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target) return;
    if (target.closest(noDragSelector)) return;
    const drag = currentWindow?.startDragging?.();
    if (drag?.catch) drag.catch(() => {});
  });

  listen(EVENT_RUNS, event => {
    latestRuns = Array.isArray(event.payload) ? event.payload : [];
    if (typeof window.update === "function") window.update(latestRuns);
    renderDocumentTitle(latestRuns);
  });

  function renderDocumentTitle(runs) {
    const liveRuns = runs.filter(run => run.state === "live");
    if (liveRuns.length > 0) {
      const agents = liveRuns.reduce((sum, run) => sum + (Array.isArray(run.tasks) ? run.tasks.length : 0), 0);
      document.title = `Ringside ${liveRuns.length} ringer${liveRuns.length === 1 ? "" : "s"} · ${agents} agent${agents === 1 ? "" : "s"}`;
      return;
    }
    if (runs.length > 0) {
      const newest = newestRun(runs);
      document.title = `Ringside ${finalTickerText(newest)}`;
      return;
    }
    document.title = `Ringside ${HUD_BUILD}`;
  }

  function finalTickerText(run) {
    const name = run.run_name || "ringer";
    if (run.state === "died") return `${name} · died`;
    const pass = numberOrZero(run.pass ?? run.summary?.pass ?? run.totals?.pass);
    const fail = numberOrZero(run.fail ?? run.summary?.fail ?? run.totals?.fail);
    return `${name} · ok ${pass} fail ${fail}`;
  }

  function newestRun(runs) {
    return runs.reduce((latest, run) => {
      return runTimestamp(run) > runTimestamp(latest) ? run : latest;
    }, runs[0]);
  }

  function runTimestamp(run) {
    const modified = Number(run?.mtime);
    if (Number.isFinite(modified)) return modified * 1000;
    const started = Date.parse(run?.started_at || "");
    return Number.isFinite(started) ? started : 0;
  }

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function listen(eventName, handler) {
    return tauri.event.listen(eventName, handler);
  }
})();
