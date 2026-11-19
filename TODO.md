# TODO / Roadmap

Legend: ✅ done · 🔜 next · ⏳ later · 🔑 needs credentials or permission from you

## Phase 1 — Foundation & MVP ✅
- ✅ Next.js + TS strict + Tailwind v4 design tokens (Duke palette, dark mode)
- ✅ Supabase schema (all core + future tables, RLS) and idempotent loader
- ✅ ESPN ingestion: rosters, bios, season stats, game logs, schedules, coaches, conference records
- ✅ Roster reconciliation (fixes ESPN's season-roster leakage), logged in meta.json
- ✅ Home dashboard, player database, player profiles with charts and tables
- ✅ Global typeahead search + JSON API routes with zod validation
- ✅ Daily GitHub Actions ingestion workflow
- 🔑 Create the Supabase project, run the migration, add env vars and Actions secrets
- 🔑 Connect the repo to Vercel

## Phase 2 — Historical database (partly done)
- ✅ Season explorer + decade timeline
- ✅ Player comparison with era context
- ✅ Stat-based search ("over 20 points and 5 rebounds")
- 🔜 Pre-2002 history (1905-06 → 2000-01): Sports-Reference, low-volume and cached, or a licensed/CSV export.
  Include Laettner, Hurley, Hill, Battier, J. Williams era stats, and the 1991/1992/2001 title rosters
- ✅ Cross-check computed season records against Sports-Reference (`ingestion/validate_records.py`); 2012-13 duplicate removed, 2001-02 gaps filled from `data/curated/game_corrections.json`
- 🔜 Per-season class year and jersey (ESPN gives only the latest values)
- 🔜 Game detail page (`/games/[id]`) with the full Duke box score (ESPN `summary?event=` endpoint)
- 🔜 Team season stats table (pace, ORtg/DRtg from BartTorvik, subject to terms)
- ⏳ Add earlier coaches to `data/curated/coaches.json` with citations
- ⏳ Season "historical context" blurbs, curated and cited

## Phase 3 — Media & professional careers
- 🔜 GoDuke RSS ingestion (`https://goduke.com/rss?path=mbball`, verified) → `news_articles`, with player tags matched by name
- 🔑 Duke Chronicle feed (403 to bots; find the official feed URL or ask permission)
- ⏳ Duke Today feed (correct URL needed)
- 🔑 YouTube Data API v3 highlights (`YOUTUBE_API_KEY`)
- 🔜 NBA draft history from the ESPN NBA draft endpoint, matched to `players.id`
- 🔜 NBA careers/stats via `nba_api` (Basketball-Reference as a fallback); `/pros` page answering "drafted in year X", "played for team Y", and "drafted per decade"
- ⏳ Curated `player_social_links` (official handles only; official embeds; no scraping)
- ⏳ Non-NBA pro leagues where reliable sources exist

## Phase 4 — Learning center
- ⏳ Question generator framework (`lib/learn/generators/*`): each generator takes the dataset and returns a question, answer, explanation, and record refs
- ⏳ Flashcards (players, seasons, titles, draft, records, coaches) with known/unknown tracking and resurfacing of missed cards
- ⏳ Multiple choice, fill in the blank, guess-the-player (progressive clues), stat challenges, timeline ordering
- ⏳ Study by category / decade / season
- ⏳ Supabase Auth + `user_progress` (RLS already in place)

## Phase 5 — AI & advanced discovery
- 🔑 Research assistant using the Claude API (`ANTHROPIC_API_KEY`) with tool use: the model calls typed query tools
  (`runStatQuery`, `getPlayerProfile`, `getSeasonDetail`, …) and cites record links; it never invents numbers
- ⏳ Article summaries for news items
- ⏳ Advanced metrics (PER, usage, ORtg/DRtg) once possession-level data is integrated
- ⏳ Move hot queries to SQL/RPC when the dataset outgrows in-memory loading

## Tech debt / polish
- ⏳ `espn_ingest.py --from/--to` rewrites every output file with only that range, wiping the other seasons. Merge into the existing JSON instead (or refuse partial runs)
- ⏳ `fetch_coach()` ignores `--refresh-current`, so the current season's coach is always served from cache
- ⏳ Unit tests for `stats.ts` (careerLine null handling, TS%/eFG%) and `parseStatQuery`
- ⏳ Playwright smoke tests for the main pages
- ⏳ Single-season players: show a bar chart instead of a one-point line
- ⏳ Customizable dashboard (saved widgets per user)
