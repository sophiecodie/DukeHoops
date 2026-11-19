/**
 * Core domain types. These mirror the JSON produced by ingestion/espn_ingest.py
 * and the Postgres schema in supabase/migrations. `null` always means
 * "not available from any source" — it is never a stand-in for zero.
 */

export type Nullable<T> = T | null;

export interface SourceRef {
  name: string;
  url: string;
  retrievedAt: string;
}

export interface Player {
  id: string; // canonical internal slug, stable across all records
  externalIds: { espn?: string; bbref?: string; nba?: string };
  fullName: string;
  firstName: Nullable<string>;
  lastName: Nullable<string>;
  position: Nullable<string>;
  positionAbbr: Nullable<string>;
  heightIn: Nullable<number>;
  displayHeight: Nullable<string>;
  weightLb: Nullable<number>;
  jersey: Nullable<string>;
  birthPlace: Nullable<string>;
  dateOfBirth: Nullable<string>;
  headshotUrl: Nullable<string>;
  dukeSeasons: number[];
  source: SourceRef;
}

export interface RosterEntry {
  season: number;
  playerId: string;
  jersey: Nullable<string>;
  position: Nullable<string>;
}

export interface Season {
  season: number; // end year: 2015 = 2014-15
  label: string;
  coach: Nullable<string>;
  coachIsCurated?: boolean; // true when ESPN lacked the coach and we used data/curated/coaches.json
  wins: Nullable<number>;
  losses: Nullable<number>;
  recordIsComputed: boolean;
  conferenceRecord: Nullable<string>;
  conferenceRecordIsCurated?: boolean; // true when ESPN lacked it and we used data/curated/game_corrections.json
  gamesScheduled: number;
  isCurrent: boolean;
  source: SourceRef;
}

export interface Game {
  id: string;
  espnId: Nullable<string>; // null for curated games ESPN doesn't have
  season: number;
  /** UTC timestamp, or "YYYY-MM-DD" when `timeUnknown` (format with src/lib/dates.ts, not `new Date`). */
  date: Nullable<string>;
  timeUnknown?: boolean;
  isCurated?: boolean; // from data/curated/game_corrections.json, not ESPN
  opponent: Nullable<string>;
  opponentEspnId: Nullable<string>;
  opponentLogo: Nullable<string>;
  homeAway: Nullable<"home" | "away">;
  neutralSite: boolean;
  dukeScore: Nullable<number>;
  opponentScore: Nullable<number>;
  result: Nullable<"W" | "L">;
  completed: boolean;
  seasonType: "regular" | "postseason";
  note: Nullable<string>;
  venue: Nullable<string>;
  source: SourceRef;
}

export interface PerGame {
  min: Nullable<number>;
  pts: Nullable<number>;
  reb: Nullable<number>;
  oreb: Nullable<number>;
  dreb: Nullable<number>;
  ast: Nullable<number>;
  stl: Nullable<number>;
  blk: Nullable<number>;
  tov: Nullable<number>;
  pf: Nullable<number>;
}

export interface Totals {
  fgm: Nullable<number>;
  fga: Nullable<number>;
  tpm: Nullable<number>;
  tpa: Nullable<number>;
  ftm: Nullable<number>;
  fta: Nullable<number>;
  oreb: Nullable<number>;
  dreb: Nullable<number>;
  reb: Nullable<number>;
  ast: Nullable<number>;
  stl: Nullable<number>;
  blk: Nullable<number>;
  tov: Nullable<number>;
  pf: Nullable<number>;
  pts: Nullable<number>;
}

export interface PlayerSeasonStats {
  playerId: string;
  season: number;
  gamesPlayed: Nullable<number>;
  gamesStarted: Nullable<number>;
  perGame: PerGame;
  totals: Totals;
  shooting: { fgPct: Nullable<number>; tpPct: Nullable<number>; ftPct: Nullable<number> };
  source: SourceRef;
}

export interface PlayerGameStats {
  playerId: string;
  gameId: string;
  season: number;
  date: Nullable<string>;
  opponent: Nullable<string>;
  atVs: Nullable<string>;
  result: Nullable<string>;
  score: Nullable<string>;
  min: Nullable<number>;
  pts: Nullable<number>;
  reb: Nullable<number>;
  ast: Nullable<number>;
  stl: Nullable<number>;
  blk: Nullable<number>;
  tov: Nullable<number>;
  pf: Nullable<number>;
  fgm: Nullable<number>;
  fga: Nullable<number>;
  tpm: Nullable<number>;
  tpa: Nullable<number>;
  ftm: Nullable<number>;
  fta: Nullable<number>;
}

export interface Championship {
  season: number;
  label: string;
  opponent: string;
  score: string;
  site: string;
  coach: string;
}

export interface Coach {
  id: string;
  fullName: string;
  firstSeason: number;
  lastSeason: Nullable<number>;
  note?: string;
}

export interface DatasetMeta {
  generatedAt: string;
  seasonRange: [number | null, number | null];
  counts: Record<string, number>;
  errors: string[];
  sources: { name: string; url: string; note?: string }[];
}

export interface Dataset {
  players: Player[];
  rosters: RosterEntry[];
  seasons: Season[];
  games: Game[];
  seasonStats: PlayerSeasonStats[];
  gameStats: PlayerGameStats[];
  championships: Championship[];
  coaches: Coach[];
  meta: DatasetMeta;
  backend: "json" | "supabase";
}
