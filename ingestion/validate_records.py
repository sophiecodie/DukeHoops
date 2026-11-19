"""Cross-check season records in data/generated/seasons.json against Sports-Reference.

Read-only: never modifies data/generated/. Writes a report to ingestion/reports/record_mismatches.json.

For every completed season (the in-progress isCurrent season is skipped), fetches
https://www.sports-reference.com/cbb/schools/duke/men/{endYear}.html, parses the
"Record: W-L (conf W-L, Nth in ACC)" line, and compares overall and ACC records.

Usage:
    python ingestion/validate_records.py            # uses ingestion/.cache/ when available
    python ingestion/validate_records.py --refresh  # re-fetch every page from Sports-Reference

Exit code: 0 if every season matches, 1 on any mismatch or unparseable page.
"""
from __future__ import annotations

import argparse
import html
import json
import logging
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from http_client import HttpClient  # noqa: E402

log = logging.getLogger("validate.records")

ROOT = Path(__file__).resolve().parent.parent
SEASONS_JSON = ROOT / "data" / "generated" / "seasons.json"
REPORT_PATH = Path(__file__).resolve().parent / "reports" / "record_mismatches.json"
SR_URL = "https://www.sports-reference.com/cbb/schools/duke/men/{year}.html"
SR_DELAY_S = 3.5  # Sports-Reference asks for <= 20 requests/minute

# "Record: 31-4 (13-3, 2nd in ACC MBB)" once tags are stripped and entities unescaped
RECORD_RE = re.compile(r"Record:\s*(\d+)-(\d+)\s*\(\s*(\d+)-(\d+)\s*,[^)]*?\bACC\b")
WL_RE = re.compile(r"^\s*(\d+)-(\d+)\s*$")


def parse_wl(s: str | None) -> tuple[int, int] | None:
    m = WL_RE.match(s or "")
    return (int(m.group(1)), int(m.group(2))) if m else None


def parse_sr_record(page: str) -> dict[str, tuple[int, int]] | None:
    text = html.unescape(re.sub(r"<[^>]+>", " ", page))
    text = re.sub(r"\s+", " ", text)
    m = RECORD_RE.search(text)
    if not m:
        return None
    w, l, cw, cl = map(int, m.groups())
    return {"overall": (w, l), "acc": (cw, cl)}


def fmt(wl: tuple[int, int] | None) -> str:
    return f"{wl[0]}-{wl[1]}" if wl else "—"


def diff(ours: tuple[int, int] | None, ref: tuple[int, int]) -> str | None:
    """None if equal; otherwise a human-readable 'ours − Sports-Ref' difference."""
    if ours is None:
        return "ours missing"
    dw, dl = ours[0] - ref[0], ours[1] - ref[1]
    if dw == 0 and dl == 0:
        return None
    return f"W {dw:+d}, L {dl:+d}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--refresh", action="store_true", help="bypass the cache and re-fetch from Sports-Reference")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    seasons: list[dict[str, Any]] = json.loads(SEASONS_JSON.read_text(encoding="utf-8"))
    skipped = [s for s in seasons if s.get("isCurrent")]
    to_check = sorted((s for s in seasons if not s.get("isCurrent")), key=lambda s: s["season"])

    http = HttpClient(delay_s=SR_DELAY_S)
    rows: list[dict[str, Any]] = []
    for s in to_check:
        year = s["season"]
        url = SR_URL.format(year=year)
        ours_overall = (s["wins"], s["losses"]) if s.get("wins") is not None and s.get("losses") is not None else None
        ours_acc = parse_wl(s.get("conferenceRecord"))
        row: dict[str, Any] = {
            "season": year,
            "label": s["label"],
            "ours": {"overall": fmt(ours_overall), "acc": fmt(ours_acc) if ours_acc else None,
                     "source": (s.get("source") or {}).get("url")},
            "sportsReference": None,
            "overallDiff": None,
            "accDiff": None,
            "status": "ok",
            "sourceUrl": url,
        }
        page = http.get_text(url, use_cache=not args.refresh)
        ref = parse_sr_record(page) if page else None
        if ref is None:
            row["status"] = "fetch_error" if page is None else "parse_error"
        else:
            row["sportsReference"] = {"overall": fmt(ref["overall"]), "acc": fmt(ref["acc"])}
            row["overallDiff"] = diff(ours_overall, ref["overall"])
            row["accDiff"] = diff(ours_acc, ref["acc"])
            if row["overallDiff"] or row["accDiff"]:
                row["status"] = "mismatch"
        rows.append(row)

    # ---- table
    header = f"{'season':<8} | {'ours':<14} | {'Sports-Ref':<14} | {'overall diff':<14} | ACC diff"
    print("\n" + header)
    print("-" * len(header))
    for r in rows:
        ours = f"{r['ours']['overall']} ({r['ours']['acc'] or '—'})"
        if r["sportsReference"]:
            sr = f"{r['sportsReference']['overall']} ({r['sportsReference']['acc']})"
            od, ad = r["overallDiff"] or "ok", r["accDiff"] or "ok"
        else:
            sr, od, ad = r["status"], "?", "?"
        print(f"{r['label']:<8} | {ours:<14} | {sr:<14} | {od:<14} | {ad}")

    mismatches = [r for r in rows if r["status"] == "mismatch"]
    errors = [r for r in rows if r["status"] in ("fetch_error", "parse_error")]
    print(f"\nChecked {len(rows)} seasons: {len(mismatches)} mismatch(es), {len(errors)} fetch/parse error(s).")
    for s in skipped:
        print(f"Skipped, in progress: {s['label']}")
    print(f"HTTP: {http.live_requests} live request(s), {http.cache_hits} cache hit(s)")

    # ---- report
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reference": {"name": "Sports-Reference (College Basketball Reference)", "urlPattern": SR_URL},
        "checked": len(rows),
        "mismatchCount": len(mismatches),
        "errorCount": len(errors),
        "skippedInProgress": [s["label"] for s in skipped],
        "mismatches": mismatches,
        "errors": errors,
        "seasons": rows,
    }
    REPORT_PATH.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    print(f"Report: {REPORT_PATH.relative_to(ROOT)}")

    return 1 if mismatches or errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
