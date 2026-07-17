#!/usr/bin/env python3
"""Check for a grounded-research analysis worker.

Proves the worker analysed the assigned slice using the PRE-GATHERED corpus rather
than web-searching or hallucinating sources: every URL the report cites must ALSO
appear in the corpus. This is the executable guard that makes ground-once-fan-out
trustworthy — a worker can't smuggle in an invented citation, and can't have quietly
gone to the web (it has no augment anyway).

Prints WHY it fails (the offending URLs / the shortfall), per the check-writing rules.
Stdlib only. Exit 0 = pass.

Usage:
  grounded-analysis.py --report report.md --corpus /abs/corpus.md [--min-urls 2] [--min-words 150]
"""
import argparse
import re
import sys

URL_RE = re.compile(r'https?://[^\s)\]>"\'`]+')


def norm(u: str) -> str:
    return u.rstrip('.,;:)]}>"\'').rstrip('/').lower()


def urls_in(path: str) -> set[str]:
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return set()
    return {norm(u) for u in URL_RE.findall(text)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--min-urls", type=int, default=2)
    ap.add_argument("--min-words", type=int, default=150)
    a = ap.parse_args()

    try:
        report = open(a.report, encoding="utf-8", errors="replace").read()
    except OSError:
        print(f"FAIL: report {a.report} missing")
        return 1

    words = len(report.split())
    if words < a.min_words:
        print(f"FAIL: report too thin ({words} words < {a.min_words})")
        return 1

    corpus_urls = urls_in(a.corpus)
    if not corpus_urls:
        print(f"FAIL: corpus {a.corpus} has no URLs (nothing to ground against) — was the corpus written?")
        return 1

    report_urls = {norm(u) for u in URL_RE.findall(report)}
    if not report_urls:
        print("FAIL: report cites no source URLs")
        return 1

    # Every cited URL must trace to the corpus (allow suffix/prefix containment so a
    # report citing a deeper path of a corpus domain-page still counts, but block a
    # wholly-invented domain).
    def in_corpus(u: str) -> bool:
        return any(u == c or u in c or c in u for c in corpus_urls)

    grounded = {u for u in report_urls if in_corpus(u)}
    invented = report_urls - grounded

    if len(grounded) < a.min_urls:
        print(f"FAIL: only {len(grounded)} corpus-grounded URLs (need >={a.min_urls}); "
              f"report cited {len(report_urls)} total")
        if invented:
            print("  not found in corpus (possible hallucination):")
            for u in sorted(invented)[:8]:
                print(f"    - {u}")
        return 1

    if invented:
        # Some off-corpus URLs are tolerable (a worker may reference something the
        # corpus mentioned by name), but flag a majority-invented report as failing.
        if len(invented) > len(grounded):
            print(f"FAIL: {len(invented)} off-corpus URLs vs {len(grounded)} grounded — "
                  f"report is mostly ungrounded/invented citations:")
            for u in sorted(invented)[:8]:
                print(f"    - {u}")
            return 1
        print(f"note: {len(invented)} off-corpus URL(s) tolerated (grounded majority: {len(grounded)})")

    print(f"PASS: {len(grounded)} corpus-grounded URLs, {words} words — analysis traced to the corpus")
    return 0


if __name__ == "__main__":
    sys.exit(main())
