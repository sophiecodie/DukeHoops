"""Upsert data/generated/*.json into Supabase (Postgres) via the PostgREST API.

Requires env vars (never commit these):
    SUPABASE_URL                 e.g. https://xyzcompany.supabase.co
    SUPABASE_SERVICE_ROLE_KEY    service role key (bypasses RLS; server/CI only)

Usage:
    python ingestion/supabase_load.py            # upsert everything
    python ingestion/supabase_load.py --dry-run  # validate + print counts only

Idempotent: every table is upserted on its natural key, so re-running never duplicates rows.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import requests

log = logging.getLogger("ingest.supabase")
DATA = Path(__file__).resolve().parent.parent / "data"
BATCH = 500


def load(name: str) -> Any:
    return json.loads((DATA / "generated" / f"{name}.json").read_text(encoding="utf-8"))


def to_int(v: Any) -> int | None:
    return None if v is None else int(round(v))


# ---------- mappers: JSON (camelCase) → table rows (snake_case) ----------

def player_rows(players: list[dict]) -> Iterable[dict]:
    for p in players:
        yield {
            "id": p["id"], "espn_id": p["externalIds"].get("espn"), "full_name": p["fullName"],
            "first_name": p["firstName"], "last_name": p["lastName"], "position": p["position"],
            "position_abbr": p["positionAbbr"], "height_in": p["heightIn"], "display_height": p["displayHeight"],
            "weight_lb": p["weightLb"], "jersey": p["jersey"], "birth_place": p["birthPlace"],
            "date_of_birth": p["dateOfBirth"], "headshot_url": p["headshotUrl"], "source": p["source"],
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }


def season_rows(seasons: list[dict], champs: set[int]) -> Iterable[dict]:
    for s in seasons:
        yield {
            "season": s["season"], "label": s["label"], "coach_name": s["coach"], "wins": s["wins"],
            "losses": s["losses"], "record_is_computed": s["recordIsComputed"],
            "conference_record": s["conferenceRecord"], "games_scheduled": s["gamesScheduled"],
            "conference_record_is_curated": bool(s.get("conferenceRecordIsCurated")),
            "is_current": s["isCurrent"], "ncaa_champion": s["season"] in champs, "source": s["source"],
        }


def roster_rows(rosters: list[dict]) -> Iterable[dict]:
    for r in rosters:
        yield {"season": r["season"], "player_id": r["playerId"], "jersey": r["jersey"], "position": r["position"], "source": r.get("source")}


def game_rows(games: list[dict]) -> Iterable[dict]:
    for g in games:
        yield {
            "id": g["id"], "espn_id": g["espnId"], "season": g["season"],
            # a date-only (tip time unknown) game is stored as 00:00 UTC that day; time_unknown says to ignore the time
            "game_date": f"{g['date']}T00:00:00Z" if g.get("timeUnknown") else g["date"],
            "is_curated": bool(g.get("isCurated")), "time_unknown": bool(g.get("timeUnknown")),
            "opponent_name": g["opponent"], "opponent_logo": g["opponentLogo"], "home_away": g["homeAway"],
            "neutral_site": g["neutralSite"], "duke_score": to_int(g["dukeScore"]),
            "opponent_score": to_int(g["opponentScore"]), "result": g["result"], "completed": g["completed"],
            "season_type": g["seasonType"], "note": g["note"], "venue": g["venue"], "source": g["source"],
        }


def pss_rows(rows: list[dict]) -> Iterable[dict]:
    for r in rows:
        pg, t, sh = r["perGame"], r["totals"], r["shooting"]
        yield {
            "player_id": r["playerId"], "season": r["season"],
            "games_played": to_int(r["gamesPlayed"]), "games_started": to_int(r["gamesStarted"]),
            **{f"{k}_pg": pg[k] for k in ["min", "pts", "reb", "oreb", "dreb", "ast", "stl", "blk", "tov", "pf"]},
            **{k: to_int(t[k]) for k in ["fgm", "fga", "tpm", "tpa", "ftm", "fta", "oreb", "dreb", "reb", "ast", "stl", "blk", "tov", "pf", "pts"]},
            "fg_pct": sh["fgPct"], "tp_pct": sh["tpPct"], "ft_pct": sh["ftPct"], "source": r["source"],
        }


def pgs_rows(rows: list[dict]) -> Iterable[dict]:
    for r in rows:
        yield {
            "player_id": r["playerId"], "game_id": r["gameId"], "season": r["season"], "game_date": r["date"],
            "opponent": r["opponent"], "at_vs": r["atVs"], "result": r["result"], "score": r["score"], "min": r["min"],
            **{k: to_int(r[k]) for k in ["pts", "reb", "ast", "stl", "blk", "tov", "pf", "fgm", "fga", "tpm", "tpa", "ftm", "fta"]},
            "source": r["source"],
        }


def coach_rows() -> Iterable[dict]:
    doc = json.loads((DATA / "curated" / "coaches.json").read_text(encoding="utf-8"))
    for c in doc["coaches"]:
        yield {"id": c["id"], "full_name": c["fullName"], "first_season": c["firstSeason"], "last_season": c["lastSeason"],
               "note": c.get("note"), "source": doc["_source"]}


# ---------- PostgREST upsert ----------

class Supabase:
    def __init__(self, url: str, key: str):
        self.base = url.rstrip("/") + "/rest/v1"
        self.s = requests.Session()
        self.s.headers.update({"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"})

    def upsert(self, table: str, rows: list[dict], on_conflict: str) -> None:
        for i in range(0, len(rows), BATCH):
            chunk = rows[i:i + BATCH]
            r = self.s.post(f"{self.base}/{table}", params={"on_conflict": on_conflict}, data=json.dumps(chunk),
                            headers={"Prefer": "resolution=merge-duplicates,return=minimal"}, timeout=60)
            if r.status_code >= 300:
                raise RuntimeError(f"{table} upsert failed ({r.status_code}): {r.text[:500]}")
        log.info("  %-22s %5d rows", table, len(rows))

    def log_run(self, status: str, counts: dict, errors: list) -> None:
        self.s.post(f"{self.base}/ingestion_logs", data=json.dumps([{
            "source_id": "espn", "status": status, "counts": counts, "errors": errors,
            "finished_at": datetime.now(timezone.utc).isoformat()}]), timeout=30)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    champs = {c["season"] for c in json.loads((DATA / "curated" / "championships.json").read_text(encoding="utf-8"))["championships"]}
    plan = [
        ("coaches", list(coach_rows()), "id"),
        ("players", list(player_rows(load("players"))), "id"),
        ("seasons", list(season_rows(load("seasons"), champs)), "season"),
        ("rosters", list(roster_rows(load("rosters"))), "season,player_id"),
        ("games", list(game_rows(load("games"))), "id"),
        ("player_season_stats", list(pss_rows(load("player_season_stats"))), "player_id,season"),
        ("player_game_stats", list(pgs_rows(load("player_game_stats"))), "player_id,game_id"),
    ]

    # Validation: FK integrity before touching the database
    player_ids = {r["id"] for r in plan[1][1]}
    season_ids = {r["season"] for r in plan[2][1]}
    problems = [f"roster→player {r['player_id']}" for r in plan[3][1] if r["player_id"] not in player_ids]
    problems += [f"roster→season {r['season']}" for r in plan[3][1] if r["season"] not in season_ids]
    problems += [f"stats→player {r['player_id']}" for r in plan[5][1] if r["player_id"] not in player_ids]
    if problems:
        log.error("Validation failed (%d): %s", len(problems), problems[:10])
        return 1

    if args.dry_run:
        for table, rows, _ in plan:
            log.info("  %-22s %5d rows (dry run)", table, len(rows))
        return 0

    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
        return 2
    sb = Supabase(url, key)
    counts: dict[str, int] = {}
    try:
        for table, rows, conflict in plan:
            sb.upsert(table, rows, conflict)
            counts[table] = len(rows)
        sb.log_run("success", counts, [])
    except Exception as exc:
        log.exception("Load failed")
        sb.log_run("failed", counts, [str(exc)])
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
