"""Ingest Duke men's basketball data from ESPN's public (unofficial) JSON endpoints.

Produces normalized JSON in data/generated/ that the Next.js app reads directly,
and that supabase_load.py can upsert into Postgres.

Usage:
    python ingestion/espn_ingest.py                 # all seasons ESPN has (2002 → current)
    python ingestion/espn_ingest.py --from 2020     # subset of seasons
    python ingestion/espn_ingest.py --refresh-current  # bypass cache for the current season

Data rules (see README "Data integrity"):
- Values ESPN does not provide are written as null, never 0.
- Every record carries a `source` object (name, url, retrievedAt).
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent))
from http_client import HttpClient  # noqa: E402

log = logging.getLogger("ingest.espn")

DUKE_ESPN_ID = "150"
CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball"
SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball"
WEB = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/mens-college-basketball"
FIRST_ESPN_SEASON = 2002  # earliest season ESPN exposes Duke rosters for
GAMELOG_SEASONS_BACK = 3  # fetch per-game logs for the most recent N seasons

OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "generated"
NOW = datetime.now(timezone.utc).isoformat(timespec="seconds")
ET = ZoneInfo("America/New_York")  # game dates are UTC; group duplicates by local (ET) calendar day
CORRECTIONS_PATH = OUT_DIR.parent / "curated" / "game_corrections.json"
DATE_ONLY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^\d{2}:\d{2}$")
WL_RE = re.compile(r"^\d+-\d+$")


def current_season_end_year(today: datetime | None = None) -> int:
    """College seasons are labeled by the calendar year they end in (2014-15 → 2015)."""
    today = today or datetime.now(timezone.utc)
    return today.year + 1 if today.month >= 10 else today.year


def season_label(end_year: int) -> str:
    return f"{end_year - 1}-{str(end_year)[-2:]}"


def slugify(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def src(url: str) -> dict[str, str]:
    return {"name": "ESPN", "url": url, "retrievedAt": NOW}


# ---------- parsing helpers (null-safe: never coerce missing to 0) ----------

def num(v: Any) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    v = str(v).strip()
    if v in ("", "-", "--", "N/A"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def made_att(v: Any) -> tuple[float | None, float | None]:
    if not isinstance(v, str) or "-" not in v:
        return None, None
    a, b = v.split("-", 1)
    return num(a), num(b)


def pct(v: Any) -> float | None:
    """ESPN percentages are 0-100 strings; store as 0-1 fractions."""
    n = num(v)
    return None if n is None else round(n / 100, 4)


# ---------- ingestion steps ----------

def fetch_roster(http: HttpClient, season: int, refresh: bool) -> list[dict]:
    url = f"{CORE}/seasons/{season}/teams/{DUKE_ESPN_ID}/athletes?limit=100"
    idx = http.get_json(url, use_cache=not refresh)
    if not idx or not idx.get("items"):
        return []
    out = []
    for item in idx["items"]:
        a = http.get_json(item["$ref"], use_cache=not refresh)
        if a:
            out.append(a)
    return out


def fetch_coach(http: HttpClient, season: int) -> str | None:
    idx = http.get_json(f"{CORE}/seasons/{season}/teams/{DUKE_ESPN_ID}/coaches")
    if not idx or not idx.get("items"):
        return None
    c = http.get_json(idx["items"][0]["$ref"])
    if not c:
        return None
    return f"{c.get('firstName', '')} {c.get('lastName', '')}".strip() or None


def fetch_conf_record(http: HttpClient, season: int, refresh: bool) -> str | None:
    d = http.get_json(f"{CORE}/seasons/{season}/types/2/teams/{DUKE_ESPN_ID}/record", use_cache=not refresh)
    for item in (d or {}).get("items", []):
        if item.get("type") == "vsconf":
            return item.get("summary")
    return None


def fetch_schedule(http: HttpClient, season: int, refresh: bool) -> list[dict]:
    games: dict[str, dict] = {}
    for stype in (2, 3):
        url = f"{SITE}/teams/{DUKE_ESPN_ID}/schedule?season={season}&seasontype={stype}"
        d = http.get_json(url, use_cache=not refresh)
        for ev in (d or {}).get("events", []):
            comp = (ev.get("competitions") or [{}])[0]
            teams = comp.get("competitors", [])
            duke = next((t for t in teams if str(t.get("id") or t.get("team", {}).get("id")) == DUKE_ESPN_ID), None)
            opp = next((t for t in teams if t is not duke), None)
            if not duke or not opp:
                continue
            completed = bool(comp.get("status", {}).get("type", {}).get("completed"))
            duke_score = num((duke.get("score") or {}).get("value")) if completed else None
            opp_score = num((opp.get("score") or {}).get("value")) if completed else None
            result = None
            if completed and duke_score is not None and opp_score is not None:
                result = "W" if duke_score > opp_score else "L"
            notes = [n.get("headline") for n in comp.get("notes", []) if n.get("headline")]
            games[ev["id"]] = {
                "id": f"espn-{ev['id']}",
                "espnId": ev["id"],
                "season": season,
                "date": ev.get("date"),
                "opponent": opp.get("team", {}).get("displayName"),
                "opponentEspnId": opp.get("team", {}).get("id"),
                "opponentLogo": ((opp.get("team", {}).get("logos") or [{}])[0]).get("href"),
                "homeAway": duke.get("homeAway"),
                "neutralSite": bool(comp.get("neutralSite")),
                "dukeScore": duke_score,
                "opponentScore": opp_score,
                "result": result,
                "completed": completed,
                "seasonType": "postseason" if stype == 3 else "regular",
                "note": notes[0] if notes else None,
                "venue": (comp.get("venue") or {}).get("fullName"),
                "source": src(url),
            }
    return sorted(games.values(), key=lambda g: g["date"] or "")


def _et_day(iso: str | None) -> str | None:
    if not iso:
        return None
    if DATE_ONLY_RE.match(iso):  # curated game with unknown tip time: already a calendar day
        return iso
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET).date().isoformat()


def game_sort_key(iso: str | None) -> str:
    """Chronological sort key in ESPN's "YYYY-MM-DDTHH:MMZ" format. A date-only (tip time unknown) game
    sorts at noon ET on its day, so it lands after an evening-ET game from the day before."""
    if iso and DATE_ONLY_RE.match(iso):
        noon_et = datetime.fromisoformat(f"{iso}T12:00").replace(tzinfo=ET)
        return noon_et.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    return iso or ""


def _filled(g: dict) -> int:
    return sum(1 for v in g.values() if v is not None)


def dedupe_games(games: list[dict]) -> tuple[list[dict], dict[str, str], dict[str, list[str]]]:
    """ESPN sometimes publishes one real game under two event IDs (e.g. 2012-11-22 vs Minnesota,
    323270135 and 400408525). fetch_schedule() only dedupes by event ID, so collapse games that share the
    same ET date, opponent, and both final scores, keeping the copy with the most fields filled in.

    Same date + opponent but different or missing scores: keep both and record a warning, because that may
    be a real data conflict rather than a duplicate.

    Returns (kept games, {dropped game id: kept game id}, log).
    """
    groups: dict[tuple, list[dict]] = {}
    for g in games:
        groups.setdefault((g["season"], _et_day(g["date"]), g["opponentEspnId"]), []).append(g)

    kept: list[dict] = []
    remap: dict[str, str] = {}
    dlog: dict[str, list[str]] = {"dropped": [], "warnings": []}
    for (season, day, _), group in groups.items():
        if len(group) == 1 or day is None:
            kept.extend(group)
            continue
        scores = {(g["dukeScore"], g["opponentScore"]) for g in group}
        all_scored = all(g["dukeScore"] is not None and g["opponentScore"] is not None for g in group)
        ids = ", ".join(g["espnId"] for g in group)
        if len(scores) == 1 and all_scored:
            best = max(group, key=lambda g: (_filled(g), g["espnId"]))
            kept.append(best)
            for g in group:
                if g is not best:
                    remap[g["id"]] = best["id"]
                    dlog["dropped"].append(
                        f"{season_label(season)} {day} {g['opponent']} {g['dukeScore']:g}-{g['opponentScore']:g}: "
                        f"dropped duplicate {g['espnId']}, kept {best['espnId']}"
                    )
        else:
            kept.extend(group)
            dlog["warnings"].append(
                f"{season_label(season)} {day} {group[0]['opponent']}: {len(group)} events ({ids}) with "
                f"different or missing scores {sorted(scores, key=str)}; kept all"
            )
    for line in dlog["dropped"]:
        log.info("  schedule dedup: %s", line)
    for line in dlog["warnings"]:
        log.warning("  schedule dedup: %s", line)
    return sorted(kept, key=lambda g: (g["season"], game_sort_key(g["date"]))), remap, dlog


def load_corrections(path: Path = CORRECTIONS_PATH) -> dict:
    """Read data/curated/game_corrections.json. Fails loudly on a malformed entry: a bad correction
    should stop the run rather than quietly change a season record."""
    if not path.exists():
        return {"games": [], "seasons": [], "verifiedAt": None}
    doc = json.loads(path.read_text(encoding="utf-8"))
    verified = (doc.get("_source") or {}).get("verifiedAt")
    for c in doc.get("games", []):
        where = f"{path.name}: game {c.get('date')} {c.get('opponent')}"
        if not DATE_ONLY_RE.match(str(c.get("date"))):
            raise ValueError(f"{where}: date must be YYYY-MM-DD")
        if c.get("tipTimeET") is not None and not TIME_RE.match(str(c["tipTimeET"])):
            raise ValueError(f"{where}: tipTimeET must be HH:MM (24h, Eastern) or null")
        if not isinstance(c.get("dukeScore"), int) or not isinstance(c.get("opponentScore"), int):
            raise ValueError(f"{where}: dukeScore and opponentScore must be integers")
        if c.get("seasonType") not in ("regular", "postseason"):
            raise ValueError(f"{where}: seasonType must be 'regular' or 'postseason'")
        for k in ("season", "opponent", "opponentEspnId"):
            if not c.get(k):
                raise ValueError(f"{where}: missing {k}")
        if len(c.get("citations") or []) < 2:
            raise ValueError(f"{where}: needs at least two citations")
    for c in doc.get("seasons", []):
        if not WL_RE.match(str(c.get("conferenceRecord"))) or len(c.get("citations") or []) < 2:
            raise ValueError(f"{path.name}: season {c.get('season')} needs a W-L conferenceRecord and two citations")
    return {"games": doc.get("games", []), "seasons": doc.get("seasons", []), "verifiedAt": verified}


def curated_game(c: dict, verified_at: str | None) -> dict:
    if c.get("tipTimeET"):
        local = datetime.fromisoformat(f"{c['date']}T{c['tipTimeET']}").replace(tzinfo=ET)
        date, time_unknown = local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), False
    else:
        date, time_unknown = c["date"], True
    return {
        "id": f"curated-{c['date']}-{slugify(c['opponent'])}",
        "espnId": None,
        "season": c["season"],
        "date": date,
        "timeUnknown": time_unknown,
        "opponent": c["opponent"],
        "opponentEspnId": c["opponentEspnId"],
        "opponentLogo": None,
        "homeAway": c.get("homeAway"),
        "neutralSite": bool(c.get("neutralSite")),
        "dukeScore": float(c["dukeScore"]),
        "opponentScore": float(c["opponentScore"]),
        "result": "W" if c["dukeScore"] > c["opponentScore"] else "L",
        "completed": True,
        "seasonType": c["seasonType"],
        "note": c.get("note"),
        "venue": c.get("venue"),
        "isCurated": True,
        "source": {
            "name": "Curated: " + " + ".join(x["name"] for x in c["citations"]),
            "url": c["citations"][0]["url"],
            "retrievedAt": verified_at or NOW,
        },
    }


def apply_game_corrections(sched: list[dict], corrections: dict, season: int, clog: dict[str, list[str]]) -> list[dict]:
    """Add curated games ESPN is missing. If ESPN has a game on that ET day vs that opponent, ESPN wins:
    same score → the correction is redundant (logged as superseded); different score → warning."""
    out = list(sched)
    for c in (c for c in corrections["games"] if c["season"] == season):
        label = f"{season_label(season)} {c['date']} {c['opponent']} {c['dukeScore']}-{c['opponentScore']}"
        espn = [g for g in sched if _et_day(g["date"]) == c["date"] and g["opponentEspnId"] == c["opponentEspnId"]]
        if not espn:
            out.append(curated_game(c, corrections["verifiedAt"]))
            clog["applied"].append(f"game {label}")
        elif any(g["dukeScore"] == c["dukeScore"] and g["opponentScore"] == c["opponentScore"] for g in espn):
            clog["superseded"].append(f"game {label}: ESPN now has it ({espn[0]['espnId']}); remove the correction")
        else:
            clog["warnings"].append(
                f"game {label}: ESPN has {espn[0]['espnId']} with {espn[0]['dukeScore']}-{espn[0]['opponentScore']}; kept ESPN")
    return sorted(out, key=lambda g: game_sort_key(g["date"]))


def apply_conf_correction(espn_conf: str | None, corrections: dict, season: int,
                          clog: dict[str, list[str]]) -> tuple[str | None, bool]:
    """Returns (conference record, is_curated). Curated value is used only when ESPN's is null."""
    c = next((c for c in corrections["seasons"] if c["season"] == season), None)
    if c is None:
        return espn_conf, False
    label = f"{season_label(season)} ACC {c['conferenceRecord']}"
    if espn_conf is None:
        clog["applied"].append(f"conference record {label}")
        return c["conferenceRecord"], True
    if espn_conf == c["conferenceRecord"]:
        clog["superseded"].append(f"conference record {label}: ESPN now has it; remove the correction")
    else:
        clog["warnings"].append(f"conference record {label}: ESPN has {espn_conf}; kept ESPN")
    return espn_conf, False


def remap_game_logs(game_logs: list[dict], remap: dict[str, str]) -> list[dict]:
    """Point player game-log rows at the kept game ID and drop rows that become duplicates."""
    out: dict[tuple[str, str], dict] = {}
    for row in game_logs:
        row = {**row, "gameId": remap.get(row["gameId"], row["gameId"])}
        out.setdefault((row["playerId"], row["gameId"]), row)
    return list(out.values())


AVG_KEYS = ["gp", "gs", "min", "fg", "fgPct", "tp", "tpPct", "ft", "ftPct", "oreb", "dreb", "reb", "ast", "blk", "stl", "pf", "tov", "pts"]
TOT_KEYS = ["fg", "fgPct", "tp", "tpPct", "ft", "ftPct", "oreb", "dreb", "reb", "ast", "blk", "stl", "pf", "tov", "pts"]


def parse_stat_rows(category: dict, keys: list[str]) -> dict[int, dict]:
    rows: dict[int, dict] = {}
    labels = category.get("labels") or []
    for s in category.get("statistics", []):
        if str(s.get("teamId")) != DUKE_ESPN_ID:
            continue
        year = (s.get("season") or {}).get("year")
        if year is None:
            continue
        rows[int(year)] = dict(zip(keys if len(keys) == len(labels) else labels, s.get("stats", [])))
    return rows


def fetch_player_seasons(http: HttpClient, espn_id: str, player_id: str, refresh: bool) -> list[dict]:
    url = f"{WEB}/athletes/{espn_id}/stats"
    d = http.get_json(url, use_cache=not refresh)
    if not d:
        return []
    cats = {c.get("name"): c for c in d.get("categories", [])}
    avgs = parse_stat_rows(cats.get("averages", {}), AVG_KEYS)
    tots = parse_stat_rows(cats.get("totals", {}), TOT_KEYS)
    out = []
    for year in sorted(set(avgs) | set(tots)):
        a, t = avgs.get(year, {}), tots.get(year, {})
        fgm, fga = made_att(t.get("fg"))
        tpm, tpa = made_att(t.get("tp"))
        ftm, fta = made_att(t.get("ft"))
        out.append({
            "playerId": player_id,
            "season": year,
            "gamesPlayed": num(a.get("gp")),
            "gamesStarted": num(a.get("gs")),
            "perGame": {
                "min": num(a.get("min")), "pts": num(a.get("pts")), "reb": num(a.get("reb")),
                "oreb": num(a.get("oreb")), "dreb": num(a.get("dreb")), "ast": num(a.get("ast")),
                "stl": num(a.get("stl")), "blk": num(a.get("blk")), "tov": num(a.get("tov")), "pf": num(a.get("pf")),
            },
            "totals": {
                "fgm": fgm, "fga": fga, "tpm": tpm, "tpa": tpa, "ftm": ftm, "fta": fta,
                "oreb": num(t.get("oreb")), "dreb": num(t.get("dreb")), "reb": num(t.get("reb")),
                "ast": num(t.get("ast")), "stl": num(t.get("stl")), "blk": num(t.get("blk")),
                "tov": num(t.get("tov")), "pf": num(t.get("pf")), "pts": num(t.get("pts")),
            },
            "shooting": {"fgPct": pct(a.get("fgPct")), "tpPct": pct(a.get("tpPct")), "ftPct": pct(a.get("ftPct"))},
            "source": src(url),
        })
    return out


GL_KEYS = ["min", "fg", "fgPct", "tp", "tpPct", "ft", "ftPct", "reb", "ast", "blk", "stl", "pf", "tov", "pts"]


def fetch_gamelog(http: HttpClient, espn_id: str, player_id: str, season: int, refresh: bool) -> list[dict]:
    url = f"{WEB}/athletes/{espn_id}/gamelog?season={season}"
    d = http.get_json(url, use_cache=not refresh)
    if not d:
        return []
    events = d.get("events", {})
    out = []
    for st in d.get("seasonTypes", []):
        for cat in st.get("categories", []):
            for row in cat.get("events", []):
                ev = events.get(row.get("eventId"), {})
                if DUKE_ESPN_ID not in (str(ev.get("homeTeamId")), str(ev.get("awayTeamId"))):
                    continue  # game for another team (e.g. after a transfer)
                stats = dict(zip(GL_KEYS, row.get("stats", [])))
                fgm, fga = made_att(stats.get("fg"))
                tpm, tpa = made_att(stats.get("tp"))
                ftm, fta = made_att(stats.get("ft"))
                out.append({
                    "playerId": player_id,
                    "gameId": f"espn-{row.get('eventId')}",
                    "season": season,
                    "date": ev.get("gameDate"),
                    "opponent": (ev.get("opponent") or {}).get("displayName"),
                    "atVs": ev.get("atVs"),
                    "result": ev.get("gameResult"),
                    "score": ev.get("score"),
                    "min": num(stats.get("min")), "pts": num(stats.get("pts")), "reb": num(stats.get("reb")),
                    "ast": num(stats.get("ast")), "stl": num(stats.get("stl")), "blk": num(stats.get("blk")),
                    "tov": num(stats.get("tov")), "pf": num(stats.get("pf")),
                    "fgm": fgm, "fga": fga, "tpm": tpm, "tpa": tpa, "ftm": ftm, "fta": fta,
                    "source": src(url),
                })
    # ESPN can list the same game under multiple categories; dedupe by gameId
    dedup = {g["gameId"]: g for g in out}
    return sorted(dedup.values(), key=lambda g: g["date"] or "")


def fetch_current_roster_ids(http: HttpClient) -> set[str]:
    """The site API's current roster is authoritative for the in-progress season."""
    d = http.get_json(f"{SITE}/teams/{DUKE_ESPN_ID}/roster", ttl_s=6 * 3600)
    return {str(a["id"]) for a in (d or {}).get("athletes", [])}


def reconcile_rosters(players: dict[str, dict], rosters: list[dict], season_stats: list[dict], current: int,
                      current_ids: set[str]) -> tuple[list[dict], dict[str, list[str]]]:
    """ESPN's season-scoped athlete lists leak players into adjacent seasons (a recruit listed the
    year before he arrives, a departed player the year after). Rules, in order:
      1. A season with Duke box-score stats for the player is kept.
      2. Current season: kept only if the player is on the live site roster.
      3. Player with no stats anywhere (walk-on / DNP): roster entry kept.
      4. Season strictly between the player's first and last stat seasons (DNP year): kept.
      5. Otherwise dropped. Stat seasons missing from the roster are added (jersey unknown).
    """
    by_id = {p["id"]: (eid, p) for eid, p in players.items()}
    stat_seasons: dict[str, set[int]] = {}
    for s in season_stats:
        stat_seasons.setdefault(s["playerId"], set()).add(s["season"])

    recon: dict[str, list[str]] = {"dropped": [], "added": []}
    kept = []
    for r in rosters:
        eid, p = by_id[r["playerId"]]
        st = stat_seasons.get(r["playerId"], set())
        season = r["season"]
        keep = (
            season in st
            or (season == current and (eid in current_ids if current_ids else True))
            or (not st and season != current)
            or (st and min(st) < season < max(st))
        )
        if keep:
            kept.append(r)
        else:
            recon["dropped"].append(f"{p['fullName']} {season_label(season)}")
    have = {(r["season"], r["playerId"]) for r in kept}
    for pid, st in stat_seasons.items():
        if pid not in by_id:
            continue
        for season in st:
            if (season, pid) not in have:
                kept.append({"season": season, "playerId": pid, "jersey": None, "position": None,
                             "source": src(f"{WEB}/athletes/{by_id[pid][0]}/stats")})
                recon["added"].append(f"{by_id[pid][1]['fullName']} {season_label(season)}")
    for _, p in players.items():
        p["dukeSeasons"] = sorted({r["season"] for r in kept if r["playerId"] == p["id"]})
    return sorted(kept, key=lambda r: (r["season"], r["playerId"])), recon


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", type=int, default=FIRST_ESPN_SEASON)
    ap.add_argument("--to", dest="end", type=int, default=current_season_end_year())
    ap.add_argument("--refresh-current", action="store_true", help="re-fetch current season (ignore cache)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    http = HttpClient()
    current = current_season_end_year()
    errors: list[str] = []

    players: dict[str, dict] = {}  # espnId -> player
    slug_owner: dict[str, str] = {}  # slug -> espnId (collision handling)
    rosters, seasons, games = [], [], []
    game_id_remap: dict[str, str] = {}  # dropped duplicate game id -> kept game id
    dedup_log: dict[str, list[str]] = {"dropped": [], "warnings": []}
    corrections = load_corrections()
    corr_log: dict[str, list[str]] = {"applied": [], "superseded": [], "warnings": []}

    for season in range(args.start, args.end + 1):
        refresh = args.refresh_current and season == current
        log.info("Season %s", season_label(season))
        try:
            roster = fetch_roster(http, season, refresh)
        except Exception as exc:  # keep going; log and continue
            errors.append(f"roster {season}: {exc}")
            continue
        if not roster:
            log.info("  no roster data from ESPN; skipping")
            continue
        for a in roster:
            espn_id = str(a["id"])
            name = a.get("fullName") or a.get("displayName")
            if espn_id not in players:
                slug = slugify(name)
                if slug in slug_owner and slug_owner[slug] != espn_id:
                    slug = f"{slug}-{espn_id}"
                slug_owner[slug] = espn_id
                bp = a.get("birthPlace") or {}
                players[espn_id] = {
                    "id": slug,
                    "externalIds": {"espn": espn_id},
                    "fullName": name,
                    "firstName": a.get("firstName"),
                    "lastName": a.get("lastName"),
                    "position": (a.get("position") or {}).get("displayName"),
                    "positionAbbr": (a.get("position") or {}).get("abbreviation"),
                    "heightIn": num(a.get("height")),
                    "displayHeight": a.get("displayHeight"),
                    "weightLb": num(a.get("weight")),
                    "jersey": a.get("jersey"),
                    "birthPlace": ", ".join(x for x in [bp.get("city"), bp.get("state"), bp.get("country")] if x) or None,
                    "dateOfBirth": (a.get("dateOfBirth") or "")[:10] or None,
                    "headshotUrl": (a.get("headshot") or {}).get("href"),
                    "dukeSeasons": [],
                    "source": src(f"{CORE}/athletes/{espn_id}"),
                }
            p = players[espn_id]
            p["dukeSeasons"].append(season)
            if season >= max(p["dukeSeasons"]):  # most recent season wins for bio fields
                p["jersey"] = a.get("jersey") or p["jersey"]
            rosters.append({
                "season": season, "playerId": p["id"], "jersey": a.get("jersey"),
                "position": (a.get("position") or {}).get("abbreviation"),
                "source": src(f"{CORE}/seasons/{season}/teams/{DUKE_ESPN_ID}/athletes"),
            })

        sched, remap, dlog = dedupe_games(fetch_schedule(http, season, refresh))
        game_id_remap.update(remap)
        for k in dedup_log:
            dedup_log[k].extend(dlog[k])
        sched = apply_game_corrections(sched, corrections, season, corr_log)
        games.extend(sched)
        done = [g for g in sched if g["result"]]
        wins = sum(1 for g in done if g["result"] == "W")
        conf, conf_curated = apply_conf_correction(fetch_conf_record(http, season, refresh), corrections, season, corr_log)
        season_row = {
            "season": season,
            "label": season_label(season),
            "coach": fetch_coach(http, season),
            "wins": wins if done else None,
            "losses": (len(done) - wins) if done else None,
            "recordIsComputed": True,  # derived from completed games in schedule
            "conferenceRecord": conf,
            "gamesScheduled": len(sched),
            "isCurrent": season == current,
            "source": src(f"{SITE}/teams/{DUKE_ESPN_ID}/schedule?season={season}"),
        }
        if conf_curated:
            season_row["conferenceRecordIsCurated"] = True
        seasons.append(season_row)

    season_stats, game_logs = [], []
    log.info("Fetching season stats for %d players", len(players))
    for espn_id, p in players.items():
        refresh = args.refresh_current and current in p["dukeSeasons"]
        try:
            season_stats.extend(fetch_player_seasons(http, espn_id, p["id"], refresh))
        except Exception as exc:
            errors.append(f"stats {p['fullName']}: {exc}")

    # Keep only stat rows for seasons in the ingested range
    season_stats = [s for s in season_stats if args.start <= s["season"] <= args.end]
    current_ids = fetch_current_roster_ids(http) if args.start <= current <= args.end else set()
    rosters, recon = reconcile_rosters(players, rosters, season_stats, current, current_ids)
    log.info("Roster reconciliation: %s", {k: len(v) for k, v in recon.items()})

    for espn_id, p in players.items():
        refresh = args.refresh_current and current in p["dukeSeasons"]
        for s in p["dukeSeasons"]:
            if s > current - GAMELOG_SEASONS_BACK:
                try:
                    game_logs.extend(fetch_gamelog(http, espn_id, p["id"], s, refresh))
                except Exception as exc:
                    errors.append(f"gamelog {p['fullName']} {s}: {exc}")
    game_logs = remap_game_logs(game_logs, game_id_remap)
    players = {k: v for k, v in players.items() if v["dukeSeasons"]}

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    def write(name: str, data: Any) -> None:
        (OUT_DIR / f"{name}.json").write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")

    player_list = sorted(players.values(), key=lambda p: (p["lastName"] or "", p["firstName"] or ""))
    write("players", player_list)
    write("rosters", rosters)
    write("seasons", sorted(seasons, key=lambda s: s["season"]))
    write("games", games)
    write("player_season_stats", season_stats)
    write("player_game_stats", game_logs)
    meta = {
        "generatedAt": NOW,
        "seasonRange": [min((s["season"] for s in seasons), default=None), max((s["season"] for s in seasons), default=None)],
        "counts": {"players": len(player_list), "rosters": len(rosters), "seasons": len(seasons), "games": len(games),
                   "playerSeasonStats": len(season_stats), "playerGameStats": len(game_logs)},
        "http": {"liveRequests": http.live_requests, "cacheHits": http.cache_hits},
        "errors": errors,
        "rosterReconciliation": recon,
        "scheduleDedup": dedup_log,
        "curatedCorrections": corr_log,
        "sources": [{"name": "ESPN (unofficial public JSON API)", "url": "https://site.api.espn.com", "note": "Unofficial endpoints; may change without notice."}],
    }
    write("meta", meta)
    log.info("Done: %s", json.dumps(meta["counts"]))
    if errors:
        log.warning("%d errors: %s", len(errors), errors[:5])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
