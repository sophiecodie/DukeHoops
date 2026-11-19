import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Dataset, Game, Player, PlayerGameStats, PlayerSeasonStats, RosterEntry, Season, SourceRef } from "@/lib/types";

/** Server-side read-only Supabase access (anon key; RLS allows public reads). */

export function supabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

function client(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false },
  });
}

type Row = Record<string, unknown>;

async function selectAll(sb: SupabaseClient, table: string, order: string): Promise<Row[]> {
  const pageSize = 1000;
  const rows: Row[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb.from(table).select("*").order(order).range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const srcOf = (v: unknown): SourceRef => (v as SourceRef) ?? { name: "unknown", url: "", retrievedAt: "" };

export async function loadFromSupabase(): Promise<Omit<Dataset, "championships" | "coaches">> {
  const sb = client();
  const [pRows, rRows, sRows, gRows, pssRows, pgsRows] = await Promise.all([
    selectAll(sb, "players", "id"),
    selectAll(sb, "rosters", "season"),
    selectAll(sb, "seasons", "season"),
    selectAll(sb, "games", "game_date"),
    selectAll(sb, "player_season_stats", "season"),
    selectAll(sb, "player_game_stats", "game_date"),
  ]);

  const rosters: RosterEntry[] = rRows.map((r) => ({
    season: Number(r.season),
    playerId: String(r.player_id),
    jersey: s(r.jersey),
    position: s(r.position),
  }));
  const seasonsByPlayer = new Map<string, number[]>();
  for (const r of rosters) seasonsByPlayer.set(r.playerId, [...(seasonsByPlayer.get(r.playerId) ?? []), r.season]);

  const players: Player[] = pRows.map((r) => ({
    id: String(r.id),
    externalIds: { espn: s(r.espn_id) ?? undefined, bbref: s(r.bbref_id) ?? undefined, nba: s(r.nba_id) ?? undefined },
    fullName: String(r.full_name),
    firstName: s(r.first_name),
    lastName: s(r.last_name),
    position: s(r.position),
    positionAbbr: s(r.position_abbr),
    heightIn: n(r.height_in),
    displayHeight: s(r.display_height),
    weightLb: n(r.weight_lb),
    jersey: s(r.jersey),
    birthPlace: s(r.birth_place),
    dateOfBirth: s(r.date_of_birth),
    headshotUrl: s(r.headshot_url),
    dukeSeasons: (seasonsByPlayer.get(String(r.id)) ?? []).sort((a, b) => a - b),
    source: srcOf(r.source),
  }));

  const seasons: Season[] = sRows.map((r) => ({
    season: Number(r.season),
    label: String(r.label),
    coach: s(r.coach_name),
    wins: n(r.wins),
    losses: n(r.losses),
    recordIsComputed: Boolean(r.record_is_computed),
    conferenceRecord: s(r.conference_record),
    ...(r.conference_record_is_curated ? { conferenceRecordIsCurated: true } : {}),
    gamesScheduled: Number(r.games_scheduled ?? 0),
    isCurrent: Boolean(r.is_current),
    source: srcOf(r.source),
  }));

  const games: Game[] = gRows.map((r) => ({
    id: String(r.id),
    espnId: s(r.espn_id),
    season: Number(r.season),
    // time_unknown games store 00:00 UTC; hand the app the calendar day only, like the JSON backend
    date: r.time_unknown ? (s(r.game_date)?.slice(0, 10) ?? null) : s(r.game_date),
    ...(r.time_unknown ? { timeUnknown: true } : {}),
    ...(r.is_curated ? { isCurated: true } : {}),
    opponent: s(r.opponent_name),
    opponentEspnId: null,
    opponentLogo: s(r.opponent_logo),
    homeAway: (s(r.home_away) as Game["homeAway"]) ?? null,
    neutralSite: Boolean(r.neutral_site),
    dukeScore: n(r.duke_score),
    opponentScore: n(r.opponent_score),
    result: (s(r.result) as Game["result"]) ?? null,
    completed: Boolean(r.completed),
    seasonType: r.season_type === "postseason" ? "postseason" : "regular",
    note: s(r.note),
    venue: s(r.venue),
    source: srcOf(r.source),
  }));

  const seasonStats: PlayerSeasonStats[] = pssRows.map((r) => ({
    playerId: String(r.player_id),
    season: Number(r.season),
    gamesPlayed: n(r.games_played),
    gamesStarted: n(r.games_started),
    perGame: {
      min: n(r.min_pg), pts: n(r.pts_pg), reb: n(r.reb_pg), oreb: n(r.oreb_pg), dreb: n(r.dreb_pg),
      ast: n(r.ast_pg), stl: n(r.stl_pg), blk: n(r.blk_pg), tov: n(r.tov_pg), pf: n(r.pf_pg),
    },
    totals: {
      fgm: n(r.fgm), fga: n(r.fga), tpm: n(r.tpm), tpa: n(r.tpa), ftm: n(r.ftm), fta: n(r.fta),
      oreb: n(r.oreb), dreb: n(r.dreb), reb: n(r.reb), ast: n(r.ast), stl: n(r.stl), blk: n(r.blk),
      tov: n(r.tov), pf: n(r.pf), pts: n(r.pts),
    },
    shooting: { fgPct: n(r.fg_pct), tpPct: n(r.tp_pct), ftPct: n(r.ft_pct) },
    source: srcOf(r.source),
  }));

  const gameStats: PlayerGameStats[] = pgsRows.map((r) => ({
    playerId: String(r.player_id),
    gameId: String(r.game_id),
    season: Number(r.season),
    date: s(r.game_date),
    opponent: s(r.opponent),
    atVs: s(r.at_vs),
    result: s(r.result),
    score: s(r.score),
    min: n(r.min), pts: n(r.pts), reb: n(r.reb), ast: n(r.ast), stl: n(r.stl), blk: n(r.blk),
    tov: n(r.tov), pf: n(r.pf), fgm: n(r.fgm), fga: n(r.fga), tpm: n(r.tpm), tpa: n(r.tpa), ftm: n(r.ftm), fta: n(r.fta),
  }));

  return {
    players, rosters, seasons, games, seasonStats, gameStats,
    meta: {
      generatedAt: new Date().toISOString(),
      seasonRange: [seasons[0]?.season ?? null, seasons.at(-1)?.season ?? null],
      counts: { players: players.length, seasons: seasons.length, games: games.length },
      errors: [],
      sources: [{ name: "Supabase", url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "" }],
    },
    backend: "supabase",
  };
}
