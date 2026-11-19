# Data sources & APIs

What this project uses (or plans to use), whether it needs credentials, and what we verified.
Status as of 2026-11-17.

| Area | Source | Access | Credentials | Status |
|---|---|---|---|---|
| Rosters, player bios, season stats, game logs, schedules | **ESPN public JSON API** (unofficial) | HTTPS JSON | None | ✅ **In use** (`ingestion/espn_ingest.py`) |
| Historical stats before 2001-02, advanced metrics (PER, ORtg, usage) | Sports-Reference / College Basketball Reference | HTML pages (no API) | None, but terms restrict scraping (≈20 req/min, no bulk bots) | ⏳ Planned: polite, cached, low-volume, or a licensed export |
| Alternative college data | `cbbpy` / `sportsdataverse` (Python) | Wrap ESPN/NCAA endpoints | None | ⏳ Optional; ESPN direct already covers it |
| Advanced team metrics | BartTorvik (T-Rank) | Public pages/JSON | None, but check terms | ⏳ Planned |
| Advanced team metrics | KenPom | Paid subscription | **KenPom login** | ❌ Not used unless you buy access |
| NBA draft | ESPN core API `leagues/nba/seasons/{y}/draft/rounds` | JSON | None | ⏳ Phase 3 (verified endpoint works) |
| NBA career stats | `nba_api` (stats.nba.com) | JSON via Python package | None (but stats.nba.com blocks some cloud IPs; may need retries/proxy-free runner) | ⏳ Phase 3 |
| NBA career stats | Basketball-Reference | HTML | None; same scraping limits as Sports-Reference | ⏳ Phase 3 fallback |
| Schedules/results (corrections only) | GoDuke.com schedule pages | HTML | None; robots.txt sets **`Crawl-delay: 30`** | ✅ Cited in `data/curated/game_corrections.json`; any automated GoDuke fetch must wait ≥30s |
| News | **GoDuke.com RSS** `https://goduke.com/rss?path=mbball` | RSS 2.0 | None | ✅ Verified feed returns MBB stories; ingestion in Phase 3 |
| News | The Duke Chronicle | RSS (WordPress/SNworks) | None | ⚠️ Returned **403** to automated requests; needs the official feed URL or permission |
| News | Duke Today | RSS | None | ⚠️ `/feed` 404s; need correct feed path |
| Video | **YouTube Data API v3** | REST | **Google Cloud API key** (`YOUTUBE_API_KEY`) | ⏳ Phase 3; 10,000 quota units/day free |
| Discussion | Reddit API (r/CollegeBasketball, r/DukeBluedevils) | OAuth REST | **Reddit app client id/secret** | ⏳ Optional; anonymous RSS is blocked (403) |
| Social links | Players' official X / Instagram / TikTok profiles | Manual curation; official embeds only | None for links/embeds | ⏳ Curated table `player_social_links`. **No scraping** of X/Instagram/TikTok (their terms forbid it; their APIs are paid/limited) |
| Alumni careers | LinkedIn | — | — | ❌ **No public API for arbitrary profiles; not scraped.** Use curated public info or alumni-submitted entries |
| AI assistant | Anthropic Claude API (Messages API with tool use) | REST | **`ANTHROPIC_API_KEY`** | ⏳ Phase 5; LLM calls DB query tools, never invents stats |
| Database / auth | Supabase (Postgres + Auth) | REST + JS client | **Project URL, anon key, service role key** | ✅ Schema + loader ready; app falls back to local JSON until keys are set |
| Hosting | Vercel | — | Vercel account linked to GitHub | ⏳ Deploy when ready |

## ESPN endpoints in use

All are unofficial and undocumented — they can change without notice. The ingestion script
caches responses (`ingestion/.cache/`), rate-limits to about 3 requests per second, and retries with exponential backoff.

| Purpose | Endpoint |
|---|---|
| Team info | `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams/150` |
| Current roster (authoritative) | `…/teams/150/roster` |
| Season roster (leaky; reconciled) | `https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball/seasons/{year}/teams/150/athletes` |
| Season coach | `…/seasons/{year}/teams/150/coaches` (only populated 2013-14 onward) |
| Conference record | `…/seasons/{year}/types/2/teams/150/record` (`vsconf`) |
| Schedule & scores | `https://site.api.espn.com/…/teams/150/schedule?season={year}&seasontype={2|3}` |
| Player season stats | `https://site.web.api.espn.com/apis/common/v3/sports/basketball/mens-college-basketball/athletes/{id}/stats` |
| Player game log | `…/athletes/{id}/gamelog?season={year}` |

Coverage: **2001-02 → present** (ESPN has no Duke rosters before 2002).

## Known data limitations

- **Season rosters leak** players into adjacent seasons (a recruit listed the year before he arrives,
  a departed player the year after). `reconcile_rosters()` fixes this using Duke stat lines as ground
  truth; every drop/add is logged in `data/generated/meta.json → rosterReconciliation`.
- **Bio fields are "latest" values**: ESPN returns the player's most recent jersey, height, and class,
  not per-season values. Per-season class year is left `null` until a reliable source is added.
- **Early-2000s schedules can be incomplete** in ESPN's feed. 2001-02 is missing two games (Ball State 11/21,
  Davidson 1/2) and its ACC record. These are filled from `data/curated/game_corrections.json` (cited to
  Sports-Reference and GoDuke.com) and flagged `isCurated` / `conferenceRecordIsCurated`; tip times are unknown
  (`timeUnknown`, date stored as `YYYY-MM-DD`). ESPN data always wins if it appears later.
- **Duplicate events**: ESPN sometimes lists one game under two event IDs (2012-11-22 vs Minnesota).
  `dedupe_games()` collapses games with the same ET date, opponent, and both scores, and logs each drop in
  `meta.json → scheduleDedup`. Same date and opponent with different scores is kept and logged as a warning.
- **Record cross-check**: `ingestion/validate_records.py` compares every completed season's overall and ACC
  record with Sports-Reference (report in `ingestion/reports/`).
- **Head coach** is missing from ESPN before 2013-14; it's filled from `data/curated/coaches.json` and
  flagged `coachIsCurated`.
- **Advanced metrics**: only box-score-derivable ones (TS%, eFG%, AST/TO, FTr, 3PAr) are calculated
  and labeled "calc." PER, usage, and ORtg/DRtg need team possession data and are not shown yet.
- **Headshots** come from ESPN's CDN and exist for roughly 80 of the 194 players; others show initials.

## Credentials checklist

Put these in `.env.local` (app) or GitHub Actions secrets (ingestion). Never commit them.

```
NEXT_PUBLIC_SUPABASE_URL=          # Supabase → Project Settings → API
NEXT_PUBLIC_SUPABASE_ANON_KEY=     # safe for the browser (RLS protects data)
SUPABASE_SERVICE_ROLE_KEY=         # server/CI only — bypasses RLS
YOUTUBE_API_KEY=                   # Google Cloud console → APIs → YouTube Data API v3
ANTHROPIC_API_KEY=                 # console.anthropic.com (Phase 5)
REDDIT_CLIENT_ID= / REDDIT_CLIENT_SECRET=   # optional
```
