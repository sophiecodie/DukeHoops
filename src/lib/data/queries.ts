import { getDataset } from "./dataset";
import { byGameDate } from "@/lib/dates";
import { careerLine, seasonLabel, seasonMetric, type CareerLine, type MetricKey } from "@/lib/stats";
import { CURATED_QUESTIONS } from "@/lib/tenting/curated";
import { generateSeasonQuestions } from "@/lib/tenting/generate";
import type { QuizQuestion } from "@/lib/tenting/types";
import type { Dataset, Game, Nullable, Player, PlayerGameStats, PlayerSeasonStats, Season } from "@/lib/types";

/**
 * Query layer — the only module pages and API routes should use for data.
 * Signatures are the contract; internals can move to SQL/RPC later.
 */

function indexBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

// Derived indexes are memoized per dataset instance.
const indexCache = new WeakMap<Dataset, ReturnType<typeof buildIndexes>>();
function buildIndexes(ds: Dataset) {
  return {
    playerById: new Map(ds.players.map((p) => [p.id, p])),
    statsByPlayer: indexBy(ds.seasonStats, (s) => s.playerId),
    statsBySeason: indexBy(ds.seasonStats, (s) => s.season),
    gameStatsByPlayer: indexBy(ds.gameStats, (s) => s.playerId),
    gamesBySeason: indexBy(ds.games, (g) => g.season),
    rosterBySeason: indexBy(ds.rosters, (r) => r.season),
    seasonByYear: new Map(ds.seasons.map((s) => [s.season, s])),
  };
}
async function ctx() {
  const ds = await getDataset();
  let ix = indexCache.get(ds);
  if (!ix) {
    ix = buildIndexes(ds);
    indexCache.set(ds, ix);
  }
  return { ds, ix };
}

// ------------------------------------------------------------------ players

export interface PlayerSummary {
  id: string;
  fullName: string;
  lastName: string;
  position: Nullable<string>;
  positionAbbr: Nullable<string>;
  jersey: Nullable<string>;
  headshotUrl: Nullable<string>;
  displayHeight: Nullable<string>;
  firstSeason: number;
  lastSeason: number;
  seasons: number[];
  gamesPlayed: Nullable<number>;
  ppg: Nullable<number>;
  rpg: Nullable<number>;
  apg: Nullable<number>;
  fgPct: Nullable<number>;
  bestPpg: Nullable<number>;
  isCurrent: boolean;
}

function summarize(p: Player, stats: PlayerSeasonStats[], current: number): PlayerSummary {
  const career = careerLine(stats);
  const ppgs = stats.map((s) => s.perGame.pts).filter((v): v is number => v !== null);
  const seasons = [...p.dukeSeasons].sort((a, b) => a - b);
  return {
    id: p.id,
    fullName: p.fullName,
    lastName: p.lastName ?? p.fullName,
    position: p.position,
    positionAbbr: p.positionAbbr,
    jersey: p.jersey,
    headshotUrl: p.headshotUrl,
    displayHeight: p.displayHeight,
    firstSeason: seasons[0],
    lastSeason: seasons[seasons.length - 1],
    seasons,
    gamesPlayed: career.gamesPlayed,
    ppg: career.perGame.pts,
    rpg: career.perGame.reb,
    apg: career.perGame.ast,
    fgPct: career.shooting.fgPct,
    bestPpg: ppgs.length ? Math.max(...ppgs) : null,
    isCurrent: seasons.includes(current),
  };
}

export async function getCurrentSeasonYear(): Promise<number> {
  const { ds } = await ctx();
  return ds.seasons.find((s) => s.isCurrent)?.season ?? ds.seasons.at(-1)?.season ?? new Date().getFullYear();
}

export async function listPlayerSummaries(): Promise<PlayerSummary[]> {
  const { ds, ix } = await ctx();
  const current = await getCurrentSeasonYear();
  return ds.players.map((p) => summarize(p, ix.statsByPlayer.get(p.id) ?? [], current));
}

export interface PlayerProfile {
  player: Player;
  seasonStats: PlayerSeasonStats[];
  career: CareerLine;
  gameLogs: PlayerGameStats[];
  seasonsContext: Season[];
  teamRanks: { season: number; ppgRank: Nullable<number>; rosterSize: number }[];
}

export async function getPlayerProfile(id: string): Promise<PlayerProfile | null> {
  const { ix } = await ctx();
  const player = ix.playerById.get(id);
  if (!player) return null;
  const seasonStats = [...(ix.statsByPlayer.get(id) ?? [])].sort((a, b) => a.season - b.season);
  const teamRanks = seasonStats.map((s) => {
    const team = (ix.statsBySeason.get(s.season) ?? []).filter((t) => t.perGame.pts !== null);
    const sorted = [...team].sort((a, b) => (b.perGame.pts ?? 0) - (a.perGame.pts ?? 0));
    const idx = sorted.findIndex((t) => t.playerId === id);
    return { season: s.season, ppgRank: idx >= 0 ? idx + 1 : null, rosterSize: team.length };
  });
  return {
    player,
    seasonStats,
    career: careerLine(seasonStats),
    gameLogs: [...(ix.gameStatsByPlayer.get(id) ?? [])].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")),
    seasonsContext: player.dukeSeasons.map((y) => ix.seasonByYear.get(y)).filter((s): s is Season => Boolean(s)),
    teamRanks,
  };
}

export async function getPlayersByIds(ids: string[]): Promise<PlayerProfile[]> {
  const profiles = await Promise.all(ids.map((id) => getPlayerProfile(id)));
  return profiles.filter((p): p is PlayerProfile => p !== null);
}

/**
 * Player's share of Duke's total points in the seasons they played (calculated).
 * A rough era-neutral context: scoring environments differ by year, team share less so.
 */
export async function getScoringShare(playerId: string): Promise<Nullable<number>> {
  const { ix } = await ctx();
  const stats = ix.statsByPlayer.get(playerId) ?? [];
  let playerPts = 0;
  let teamPts = 0;
  for (const s of stats) {
    const games = (ix.gamesBySeason.get(s.season) ?? []).filter((g) => g.completed);
    if (s.totals.pts === null || games.length === 0 || games.some((g) => g.dukeScore === null)) return null;
    playerPts += s.totals.pts;
    teamPts += games.reduce((a, g) => a + (g.dukeScore ?? 0), 0);
  }
  return teamPts > 0 ? playerPts / teamPts : null;
}

// ------------------------------------------------------------------ seasons

export interface SeasonRosterRow {
  player: Player;
  jersey: Nullable<string>;
  stats: PlayerSeasonStats | null;
}

export interface SeasonDetail {
  season: Season;
  roster: SeasonRosterRow[];
  games: Game[];
  champion: boolean;
  prev: number | null;
  next: number | null;
  topGames: (PlayerGameStats & { playerName: string })[];
}

export async function listSeasons(): Promise<(Season & { champion: boolean })[]> {
  const { ds } = await ctx();
  const champs = new Set(ds.championships.map((c) => c.season));
  return [...ds.seasons].sort((a, b) => b.season - a.season).map((s) => ({ ...s, champion: champs.has(s.season) }));
}

export async function getSeasonDetail(year: number): Promise<SeasonDetail | null> {
  const { ds, ix } = await ctx();
  const season = ix.seasonByYear.get(year);
  if (!season) return null;
  const statsFor = new Map((ix.statsBySeason.get(year) ?? []).map((s) => [s.playerId, s]));
  const roster = (ix.rosterBySeason.get(year) ?? [])
    .map((r) => ({ player: ix.playerById.get(r.playerId)!, jersey: r.jersey, stats: statsFor.get(r.playerId) ?? null }))
    .filter((r) => r.player)
    .sort((a, b) => (b.stats?.perGame.pts ?? -1) - (a.stats?.perGame.pts ?? -1));
  const years = ds.seasons.map((s) => s.season).sort((a, b) => a - b);
  const i = years.indexOf(year);
  const topGames = ds.gameStats
    .filter((g) => g.season === year && g.pts !== null)
    .sort((a, b) => (b.pts ?? 0) - (a.pts ?? 0))
    .slice(0, 5)
    .map((g) => ({ ...g, playerName: ix.playerById.get(g.playerId)?.fullName ?? g.playerId }));
  return {
    season,
    roster,
    games: [...(ix.gamesBySeason.get(year) ?? [])].sort(byGameDate),
    champion: ds.championships.some((c) => c.season === year),
    prev: i > 0 ? years[i - 1] : null,
    next: i < years.length - 1 ? years[i + 1] : null,
    topGames,
  };
}

// ------------------------------------------------------------------ home

export interface HomeData {
  current: Season | null;
  recentResults: Game[];
  upcoming: Game[];
  currentRoster: PlayerSummary[];
  topSeasons: { player: Player; stats: PlayerSeasonStats }[];
  facts: { text: string; href: string }[];
  championships: Dataset["championships"];
  meta: Dataset["meta"];
  backend: Dataset["backend"];
  playerCount: number;
  seasonCount: number;
  gameCount: number;
}

export async function getHomeData(): Promise<HomeData> {
  const { ds, ix } = await ctx();
  const currentYear = await getCurrentSeasonYear();
  const current = ix.seasonByYear.get(currentYear) ?? null;
  const games = [...(ix.gamesBySeason.get(currentYear) ?? [])].sort(byGameDate);
  const summaries = await listPlayerSummaries();
  const currentRoster = summaries
    .filter((p) => p.isCurrent)
    .map((p) => {
      const cur = (ix.statsByPlayer.get(p.id) ?? []).find((s) => s.season === currentYear);
      return { ...p, ppg: cur?.perGame.pts ?? null, rpg: cur?.perGame.reb ?? null, apg: cur?.perGame.ast ?? null };
    })
    .sort((a, b) => (b.ppg ?? -1) - (a.ppg ?? -1));

  const qualified = ds.seasonStats.filter((s) => (s.gamesPlayed ?? 0) >= 15 && s.perGame.pts !== null);
  const topSeasons = [...qualified]
    .sort((a, b) => (b.perGame.pts ?? 0) - (a.perGame.pts ?? 0))
    .slice(0, 5)
    .map((stats) => ({ player: ix.playerById.get(stats.playerId)!, stats }))
    .filter((r) => r.player);

  return {
    current,
    recentResults: games.filter((g) => g.completed).slice(-5).reverse(),
    upcoming: games.filter((g) => !g.completed).slice(0, 5),
    currentRoster,
    topSeasons,
    facts: buildFacts(ds, ix),
    championships: ds.championships,
    meta: ds.meta,
    backend: ds.backend,
    playerCount: ds.players.length,
    seasonCount: ds.seasons.length,
    gameCount: ds.games.length,
  };
}

/** "Did you know?" facts — every one is computed from the dataset, never hand-written. */
function buildFacts(ds: Dataset, ix: ReturnType<typeof buildIndexes>): { text: string; href: string }[] {
  const facts: { text: string; href: string }[] = [];
  const range = ds.meta.seasonRange[0] ? `since ${seasonLabel(ds.meta.seasonRange[0])}` : "in this dataset";
  const done = ds.seasons.filter((s) => s.wins !== null && !s.isCurrent);

  const byWins = [...done].sort((a, b) => (b.wins ?? 0) - (a.wins ?? 0) || (a.losses ?? 0) - (b.losses ?? 0));
  const mostWins = byWins[0];
  if (mostWins) {
    const tied = byWins.filter((s) => s.wins === mostWins.wins).length;
    facts.push({
      text: `Duke's best record ${range} is ${mostWins.wins}-${mostWins.losses} in ${mostWins.label}${tied > 1 ? ` — one of ${tied} seasons with ${mostWins.wins} wins` : ""}.`,
      href: `/seasons/${mostWins.season}`,
    });
  }

  const qualified = ds.seasonStats.filter((s) => (s.gamesPlayed ?? 0) >= 15);
  const topReb = [...qualified].sort((a, b) => (b.perGame.reb ?? -1) - (a.perGame.reb ?? -1))[0];
  const p = topReb && ix.playerById.get(topReb.playerId);
  if (topReb && p) facts.push({ text: `${p.fullName} averaged ${topReb.perGame.reb?.toFixed(1)} rebounds per game in ${seasonLabel(topReb.season)} — the most by any Duke player ${range} (min. 15 games).`, href: `/players/${p.id}` });

  const topGame = [...ds.gameStats].filter((g) => g.pts !== null).sort((a, b) => (b.pts ?? 0) - (a.pts ?? 0))[0];
  const gp = topGame && ix.playerById.get(topGame.playerId);
  if (topGame && gp) facts.push({ text: `${gp.fullName} scored ${topGame.pts} points ${topGame.atVs === "@" ? "at" : "vs."} ${topGame.opponent} — the top single-game total among recent seasons with game logs.`, href: `/players/${gp.id}` });

  // longest winning streak across completed games
  let best = 0, run = 0, bestEnd: Game | null = null;
  for (const g of [...ds.games].filter((g) => g.result).sort(byGameDate)) {
    run = g.result === "W" ? run + 1 : 0;
    if (run > best) { best = run; bestEnd = g; }
  }
  if (bestEnd) facts.push({ text: `Duke's longest winning streak ${range} is ${best} straight games, ending in ${seasonLabel(bestEnd.season)}.`, href: `/seasons/${bestEnd.season}` });

  const jerseyCount = indexBy(ds.players.filter((p) => p.jersey), (p) => p.jersey);
  const popular = [...jerseyCount.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (popular) facts.push({ text: `${popular[1].length} different players ${range} last wore #${popular[0]} — the most common number on the roster.`, href: `/players?jersey=${popular[0]}` });

  return facts;
}

// ------------------------------------------------------------------ search

export type SearchHit =
  | { kind: "player"; id: string; title: string; subtitle: string; href: string }
  | { kind: "season"; id: string; title: string; subtitle: string; href: string }
  | { kind: "game"; id: string; title: string; subtitle: string; href: string }
  | { kind: "coach"; id: string; title: string; subtitle: string; href: string };

export interface StatFilter {
  metric: MetricKey;
  op: ">" | ">=" | "<" | "<=";
  value: number;
}

const STAT_WORDS: Record<string, MetricKey> = {
  point: "pts", points: "pts", ppg: "pts", rebound: "reb", rebounds: "reb", rpg: "reb",
  assist: "ast", assists: "ast", apg: "ast", steal: "stl", steals: "stl", block: "blk", blocks: "blk",
  minutes: "min", turnovers: "tov",
};

/** Parse phrases like "averaged more than 20 points and at least 5 rebounds". */
export function parseStatQuery(q: string): StatFilter[] {
  const filters: StatFilter[] = [];
  const re = /(more than|over|greater than|above|at least|>=|>|less than|under|below|fewer than|at most|<=|<)\s*(\d+(?:\.\d+)?)\s*([a-z]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const metric = STAT_WORDS[m[3].toLowerCase()];
    if (!metric) continue;
    const w = m[1].toLowerCase();
    const op: StatFilter["op"] =
      w === "at least" || w === ">=" ? ">=" : w === "at most" || w === "<=" ? "<=" : ["less than", "under", "below", "fewer than", "<"].includes(w) ? "<" : ">";
    filters.push({ metric, op, value: Number(m[2]) });
  }
  return filters;
}

export interface StatQueryResult {
  player: Player;
  stats: PlayerSeasonStats;
}

export async function runStatQuery(filters: StatFilter[], minGames = 10): Promise<StatQueryResult[]> {
  if (!filters.length) return [];
  const { ds, ix } = await ctx();
  const cmp = (v: number, f: StatFilter) => (f.op === ">" ? v > f.value : f.op === ">=" ? v >= f.value : f.op === "<" ? v < f.value : v <= f.value);
  return ds.seasonStats
    .filter((s) => (s.gamesPlayed ?? 0) >= minGames)
    .filter((s) => filters.every((f) => { const v = seasonMetric(s, f.metric); return v !== null && cmp(v, f); }))
    .sort((a, b) => (seasonMetric(b, filters[0].metric) ?? 0) - (seasonMetric(a, filters[0].metric) ?? 0))
    .map((stats) => ({ player: ix.playerById.get(stats.playerId)!, stats }))
    .filter((r) => r.player);
}

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

export async function searchAll(q: string, limit = 8): Promise<SearchHit[]> {
  const query = norm(q.trim());
  if (query.length < 2) return [];
  const { ds } = await ctx();
  const hits: SearchHit[] = [];

  const players = ds.players
    .map((p) => {
      const n = norm(p.fullName);
      const score = n.startsWith(query) ? 3 : n.split(" ").some((part) => part.startsWith(query)) ? 2 : n.includes(query) ? 1 : 0;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.fullName.localeCompare(b.p.fullName))
    .slice(0, limit);
  for (const { p } of players) {
    const yrs = [...p.dukeSeasons].sort((a, b) => a - b);
    hits.push({ kind: "player", id: p.id, title: p.fullName, subtitle: `${p.position ?? "Player"} · ${seasonLabel(yrs[0])}${yrs.length > 1 ? ` – ${seasonLabel(yrs.at(-1)!)}` : ""}`, href: `/players/${p.id}` });
  }

  const yearMatch = query.match(/\b(19|20)\d{2}\b/);
  for (const s of ds.seasons) {
    if ((yearMatch && (String(s.season) === yearMatch[0] || String(s.season - 1) === yearMatch[0])) || s.label.includes(query)) {
      hits.push({ kind: "season", id: String(s.season), title: `${s.label} season`, subtitle: `${s.wins ?? "?"}-${s.losses ?? "?"} · ${s.coach ?? "Coach unknown"}`, href: `/seasons/${s.season}` });
    }
  }

  for (const c of ds.coaches) {
    if (norm(c.fullName).includes(query)) hits.push({ kind: "coach", id: c.id, title: c.fullName, subtitle: `Head coach ${seasonLabel(c.firstSeason)} – ${c.lastSeason ? seasonLabel(c.lastSeason) : "present"}`, href: `/seasons?coach=${c.id}` });
  }

  if (query.length >= 3) {
    const games = ds.games.filter((g) => g.opponent && norm(g.opponent).includes(query)).sort((a, b) => byGameDate(b, a)).slice(0, limit);
    for (const g of games) {
      hits.push({ kind: "game", id: g.id, title: `${g.homeAway === "away" ? "@" : "vs."} ${g.opponent}`, subtitle: `${g.date?.slice(0, 10) ?? ""} · ${g.result ? `${g.result} ${g.dukeScore}-${g.opponentScore}` : "Scheduled"}`, href: `/seasons/${g.season}#game-${g.id}` });
    }
  }
  return hits;
}

export async function getDatasetMeta() {
  const { ds } = await ctx();
  return { meta: ds.meta, backend: ds.backend };
}

// ------------------------------------------------------------------ tenting prep

export async function getTentingQuiz(): Promise<{ questions: QuizQuestion[]; seasonLabel: string }> {
  const { ds } = await ctx();
  const year = await getCurrentSeasonYear();
  return { questions: [...generateSeasonQuestions(ds, year), ...CURATED_QUESTIONS], seasonLabel: seasonLabel(year) };
}
