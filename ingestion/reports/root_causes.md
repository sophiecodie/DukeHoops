# Record mismatches: root causes

Investigation for the 2 mismatches in `record_mismatches.json` (validator run 2026-11-18,
25 completed seasons checked, 2026-27 skipped as in progress). Read-only investigation; no code or data
was changed. All requests went through `ingestion/http_client.py` (Sports-Reference at 3.5s/request).

| Season | Ours | Sports-Reference | Cause | Classification |
|---|---|---|---|---|
| 2001-02 | 29-4, ACC — | 31-4 (13-3 ACC) | 2 games absent from every ESPN feed; ESPN has no conference record | **Missing from ESPN** |
| 2012-13 | 31-6 | 30-6 | ESPN publishes one game under two event IDs; we dedupe by event ID only | **ESPN data error that our code doesn't guard against** (fixable on our side) |

---

## 2001-02: two missing wins and missing ACC record

### Schedule diff (Sports-Reference `2002-schedule.html` vs `games.json`, matched on ET date + score)

Sports-Reference: 35 games (29 REG, 3 CTOURN, 3 NCAA). Ours: 33 games, all completed. No extra games on our side.

| Date | Opponent | Site | Score | Game type |
|---|---|---|---|---|
| 2001-11-21 | Ball State | Neutral (Maui Invitational) | W 83-71 | Regular season |
| 2002-01-02 | Davidson | Neutral | W 106-71 | Regular season |

Neither is a conference or NCAA tournament game; both are non-conference regular season, so they don't affect
the ACC record. 33 + 2 = 35 games and 29-4 + 2 W = 31-4, which accounts for the full overall difference.

### What ESPN returns

| Endpoint | Result |
|---|---|
| `site …/teams/150/schedule?season=2002&seasontype=2` | 30 events. Nov 20 Seton Hall → Nov 21 South Carolina → Nov 26 Portland (no Ball State); Dec 29 San Diego State → Jan 6 Florida State (no Davidson) |
| `…&seasontype=3` | 3 events (NCAA tournament only, Mar 15–22). The ACC tournament games are under seasontype 2 |
| `…&seasontype=1`, `…&seasontype=4` | 0 events |
| `…/schedule?season=2002` (no seasontype) | Same 30 as seasontype 2 |
| `core …/seasons/2002/teams/150/events` | `count: 33`, exactly the 33 we have |
| `site …/scoreboard?dates=20011121` / `20011122` / `20020102` / `20020103` (`groups=50` and unfiltered) | No Duke event on any of these days |
| Ball State schedule (`teams/2050`, 2002, types 2+3) | Has `at UCLA` on 2001-11-21 (the other Maui bracket game) but **no Duke game** |
| Davidson schedule (`teams/2166`, 2002, types 2+3) | Jumps from late Dec to Jan 6 @ Western Carolina, **no Duke game** |
| `core …/seasons/2002/types/2/teams/150/record` | Only `total: 27-3`. No `vsconf` item (2003 has `vsconf: 11-5`), so `fetch_conf_record` correctly returns `null` |

**Classification: missing from ESPN.** Our code requests the right endpoints and parses them correctly. ESPN
doesn't have these two games in any team, opponent, scoreboard or core endpoint, and has no 2001-02
conference record. ESPN's own `total` (27-3 regular season) is also short by the same two wins.

---

## 2012-13: one extra win (duplicate game)

### Schedule diff

Sports-Reference: 36 games (31 REG, 1 CTOURN, 4 NCAA). Ours: 37. Every Sports-Reference game is in ours. The
extra row is the **same game twice**:

| ESPN event ID | Date (UTC) | Opponent | Score | Note | Venue |
|---|---|---|---|---|---|
| `323270135` | 2012-11-22 20:30 | Minnesota | W 89-71 | "BATTLE 4 ATLANTIS AT NASSAU BAHAMAS" | null |
| `400408525` | 2012-11-22 20:30 | Minnesota | W 89-71 | "BATTLE 4 ATLANTIS" | Imperial Arena |

Game type: regular season, non-conference (Battle 4 Atlantis), so the ACC record is unaffected.

### What ESPN returns

- `site …/teams/150/schedule?season=2013&seasontype=2` lists **both** event IDs. Same teams, same tip time, same score.
- `site …/scoreboard?dates=20121122&groups=50` also lists both.
- `site …/summary?event=` works for both IDs, and each has its own box score.

### Why our code keeps both

`fetch_schedule()` in `espn_ingest.py` keys games by `ev["id"]` (`games[ev["id"]] = {...}`). That only
removes the same event seen twice, for example across seasontype 2 and 3. Two different IDs for one real
game both get through. The season record is then computed by counting completed games, so the duplicate
adds a win.

**Classification: ESPN data error, not guarded against in our code.** ESPN publishes the duplicate, but the
fix belongs in our ingestion: also dedupe on (date, opponent ID), preferring the more complete record (the
one with a venue). File-wide check: this is the only same-day, same-opponent pair in `games.json`.

**Other effects of the duplicate** (all clear once it's removed):
- `/seasons/2013` schedule shows Minnesota twice.
- `getScoringShare()` counts Duke's 89 points twice in the 2012-13 team total, so each 2012-13 player's
  share of team points is slightly low.
- The site's longest-winning-streak fact counts it as two wins. Whether that changes the reported streak
  depends on where it falls in the sequence.
- Not affected: player season stats (they come from ESPN's per-player totals) and game logs (only the last
  3 seasons are fetched).

---

## Proposed next steps (Phase 1c, pending approval)

1. **2012-13 (our side):** in `fetch_schedule()`, also dedupe on (date, opponent ESPN ID), keep the
   record with more fields filled in, and log each dropped duplicate in `meta.json`. Re-ingest 2013 and re-run the validator.
2. **2001-02 (ESPN's gap):** propose, don't build, a way to fill the two games and the ACC record from
   another source.

---

## Status after Phase 1c (2026-11-18)

- **2012-13: fixed.** `dedupe_games()` in `espn_ingest.py` dropped `323270135` and kept `400408525` (it has
  the venue). Season record 31-6 → 30-6, games 932 → 931. Validator now passes 2012-13. No other generated
  file referenced the duplicate (game logs only cover 2025–2027; rosters and season stats don't reference games).
- **2001-02: still mismatched** (ESPN gap). Proposal below; not built.

## Proposal: curated corrections for 2001-02 (not built)

### File: `data/curated/game_corrections.json`

Same layout as the other curated files (`_source` header plus records), with a citation on each record:

```json
{
  "_source": {
    "name": "Manual corrections for gaps in ESPN's feed",
    "note": "Only facts ESPN is missing. Each record cites where it came from. Re-verify before adding."
  },
  "games": [
    {
      "season": 2002, "date": "2001-11-21", "opponent": "Ball State Cardinals", "opponentEspnId": "2050",
      "neutralSite": true, "homeAway": null, "dukeScore": 83, "opponentScore": 71,
      "seasonType": "regular", "note": "Maui Invitational", "venue": null,
      "citations": [
        { "name": "Sports-Reference", "url": "https://www.sports-reference.com/cbb/schools/duke/men/2002-schedule.html" },
        { "name": "GoDuke.com 2001-02 results", "url": "<to be found and verified>" }
      ]
    },
    { "season": 2002, "date": "2002-01-02", "opponent": "Davidson Wildcats", "opponentEspnId": "2166", "…": "same shape" }
  ],
  "seasons": [
    { "season": 2002, "conferenceRecord": "13-3", "citations": [ { "name": "Sports-Reference", "url": "…/men/2002.html" } ] }
  ]
}
```

The opponent ESPN IDs (2050, 2166) are the ones ESPN's own team endpoints use, checked in Phase 1b.

### Where it is merged: in ingestion, not in the app

`espn_ingest.py` reads the file and merges it **before** computing season records. That way
`games.json`, `seasons.json`, Supabase, the validator and CI all see the same data, and "data changes only
through ingestion scripts" still holds.

(Coaches use the other approach: `dataset.ts` fills them in at load time. That works for a display-only
field, but wins and losses are computed in ingestion, so games need to be merged there too.)

### Flagging (never passed off as ESPN)

- Curated game: `id: "curated-2002-01-02-davidson"`, `espnId: null`, `isCurated: true`, and
  `source: { name: "Curated (Sports-Reference)", url: <first citation>, retrievedAt: <when verified> }`.
- Season: `conferenceRecordIsCurated: true` and `curatedGameIds: [...]`.
- UI: a "(curated)" label next to the ACC record and on the two game rows, the same way `coachIsCurated` works now.

### Safety rules

1. **Fill gaps only.** A curated game is added only if ESPN has no game on that ET day against that
   opponent. If ESPN later adds it, ESPN wins, and the run logs "curated correction superseded, remove it".
   This reuses the same date + opponent + score matching as `dedupe_games()`.
2. **ACC record:** used only when ESPN's value is `null`. If ESPN later returns a different value, keep
   ESPN's and log a warning.
3. **Log everything** in `meta.json → curatedCorrections` (games added or superseded, fields filled).
4. **Validator:** no change needed. It reads `seasons.json`, so it passes once ingestion has merged the
   corrections, and it still catches a correction that's wrong.

### Code changes it would need

- `espn_ingest.py`: load and merge the file (about 40 lines).
- `src/lib/types.ts`: `Game.espnId` becomes `Nullable<string>`; add optional `isCurated` to `Game` and
  `conferenceRecordIsCurated` to `Season`. The `games.espn_id` column is `text unique`, which allows
  multiple NULLs, so no database migration is needed.
- `supabase-source.ts` and `supabase_load.py`: carry the new flags. That would need an `is_curated` column
  (a small migration); otherwise the flags exist only in the JSON backend.
- UI: the "(curated)" labels.

### Open questions

1. **Tip times:** Sports-Reference's 2001-02 schedule has no tip times. `GameRow` shows a time in ET, and a
   date-only value would show as 7 or 8pm the day before. Options: (a) use the real tip time if GoDuke
   lists it, otherwise (b) a date-only value plus `timeUnknown: true` so the row shows "time unknown".
2. **Second source:** require a GoDuke citation next to Sports-Reference for each correction? (Recommended.)

---

## Status: 2001-02 corrections built

The open questions were decided as: GoDuke tip time if listed, otherwise none (`timeUnknown`); cite both
Sports-Reference and GoDuke.

- `data/curated/game_corrections.json`: the Ball State and Davidson games and the 13-3 ACC record, each with
  two citations. GoDuke lists both tip times as "TBA", so both are `tipTimeET: null`. Venues come from
  Sports-Reference (GoDuke lists only cities).
- `espn_ingest.py` merges them only where ESPN has nothing; the run is logged in `meta.json → curatedCorrections`.
- Validator: **0 mismatches** across 25 completed seasons (2001-02 now 31-4, 13-3 ACC).
- Note: GoDuke's robots.txt sets `Crawl-delay: 30`. The two GoDuke pages used here were fetched once with
  a 3.5s delay and are cached; any future GoDuke ingestion must wait at least 30s between requests.
