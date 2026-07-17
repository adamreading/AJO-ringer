# grounded-research

## What it is

Ground **once**, fan out **analysis**. The orchestrator does a small, controlled set
of web searches up front, assembles a single **cited corpus**, and then fans N cheap
analysis workers out over that *same* corpus — the workers never touch the web.

This is the search-efficient inverse of "N augmented workers each search the web": an
agentic worker re-searches on *every* step, so a 6-worker augmented run can fire ~60
searches and exhaust a rate-limited free search tier mid-run (learned live, 2026-07-17).
Grounding once takes that to **~6 searches → 1 grounding pass**, and — because the
orchestrator grounds with its own WebSearch/WebFetch — those searches don't even hit
Feeder's rate-limited augment tier.

## When to use

- Any research/market/landscape/prediction brief where the web data can be gathered up
  front (most of them).
- When you want **source control**: you vet the citations once, so no per-worker
  hallucinated URLs (the failure mode of blind/ungrounded workers).
- When the analysis has parallel slices (per competitor, per dimension, per question)
  worth fanning out — otherwise just ground and synthesize yourself (see Swarm-ROI: a
  single reasoning answer isn't swarm-worthy).

**When NOT to use — reach for worker-augment instead** (`engine: opencode-research`,
`augment:force`): only when the research is too broad to pre-gather, so workers must
search live. Then run at LOW concurrency (`--max-parallel` 2-3) to stay under the free
tier, and ALWAYS run the post-hoc `augmented` audit before trusting the output.

## The flow

1. **Ground (orchestrator, off-tier).** Run a handful of targeted WebSearch/WebFetch
   calls — one small set per research question, not per worker. Vet the sources.
2. **Write the corpus.** Assemble the findings + every source URL into a single
   `corpus.md` at `{{CORPUS_PATH}}` (an absolute path readable by every worker, e.g.
   under `{{WORKDIR}}`). Structure it so each fact carries its URL.
3. **Fan out analysis.** Each analysis worker (plain `opencode`, NO augment) reads the
   corpus for its source MATERIAL and writes its slice of analysis, citing the corpus's
   URLs. The instructions live in the spec; the corpus is pointed to as material (this
   is allowed — pointer specs are only banned for *instructions*).
4. **Verify.** The check cross-references each report's cited URLs against the corpus —
   proving the worker used the grounded material, not invented sources.
5. **Synthesize.** The orchestrator writes the final recommendation/answer from the
   analysis slices (apply any proprietary/IP lens here, in-house).

## Fill in

| Placeholder | What goes there |
|---|---|
| `{{TOPIC}}` | Short topic slug for the run name. |
| `{{WORKDIR}}` | Absolute scratch dir where Ringer creates task directories. |
| `{{CORPUS_PATH}}` | Absolute path to the `corpus.md` you wrote in step 2 (workers read this). |
| `{{CHECK_SCRIPT_PATH}}` | Absolute path to `templates/grounded-research/checks/grounded-analysis.py`. |
| `{{ANALYSIS_KEY}}` | Stable task key per analysis slice. |
| `{{ANALYSIS_INSTRUCTIONS}}` | What this slice must analyse (the instructions, self-contained). |
| `{{MIN_CORPUS_URLS}}` | Minimum corpus-sourced URLs the report must cite (e.g. 2-3). |

## Notes

- Analysis workers use `engine: opencode` (cheap, no web) — **never** `opencode-research`
  here; the whole point is they don't search.
- Keep the corpus outside any task worktree (an absolute path) so every worker can read
  it even under `worktrees: true`.
- One grounding pass, reused by all workers = the corpus is the single source of truth;
  fix a bad source once and every downstream analysis inherits the fix.
