import type { Dataset, Game, Player, PlayerSeasonStats } from "@/lib/types";
import { seasonLabel } from "@/lib/stats";
import { byGameDate, formatGameDay } from "@/lib/dates";
import { seededShuffle, type QuizQuestion } from "./types";

/**
 * Builds practice questions from the live dataset for the current season. These cover the parts of the tests
 * that change every year: roster table, game results, records, team leaders.
 * Every answer comes from the data, never written by hand, so it updates with each ingestion run.
 */

const dateFmt = (iso: string | null) => formatGameDay(iso) ?? "date TBD";
const place = (p: Player) => p.birthPlace?.replace(/, USA$/, "") ?? null;
const schoolName = (opp: string | null) => opp ?? "Unknown opponent";

/** Up to `n` distinct distractors that differ from the answer, chosen deterministically. */
function choicesFor(answer: string, pool: (string | null)[], seed: string, n = 3): string[] {
  const others = [...new Set(pool.filter((v): v is string => !!v && v !== answer))];
  return seededShuffle([answer, ...seededShuffle(others, seed).slice(0, n)], `${seed}:order`);
}

export function generateSeasonQuestions(ds: Dataset, year: number): QuizQuestion[] {
  const qs: QuizQuestion[] = [];
  const label = seasonLabel(year);
  const src = { label: `${label} season data (ESPN)`, href: `/seasons/${year}` };

  // ------------------------------------------------------------ roster: jersey, hometown, height
  const rosterJersey = new Map(ds.rosters.filter((r) => r.season === year).map((r) => [r.playerId, r.jersey]));
  const roster = ds.players.filter((p) => p.dukeSeasons.includes(year));
  const jerseyOf = (p: Player) => rosterJersey.get(p.id) ?? p.jersey;

  for (const p of roster) {
    const jersey = jerseyOf(p);
    if (jersey) {
      qs.push({
        id: `jersey-${p.id}`, category: "Roster", points: 1, generated: true, source: { label: "Player profile", href: `/players/${p.id}` },
        prompt: `What jersey number does ${p.fullName} wear this season?`,
        answer: `#${jersey}`,
        choices: choicesFor(`#${jersey}`, roster.map((o) => (jerseyOf(o) ? `#${jerseyOf(o)}` : null)), `j-${p.id}`),
      });
    }
    const home = place(p);
    if (home) {
      qs.push({
        id: `home-${p.id}`, category: "Roster", points: 1, generated: true, source: { label: "Player profile", href: `/players/${p.id}` },
        prompt: `Where is ${p.fullName} from?`,
        answer: home,
        choices: choicesFor(home, roster.map(place), `h-${p.id}`),
        explanation: "From ESPN's listed birthplace. The test grades hometowns from the GoDuke.com roster, which sometimes lists a different city, so double-check there. Spelling counts on the roster question.",
      });
    }
  }

  const tall = roster.filter((p) => (p.heightIn ?? 0) >= 84).sort((a, b) => (b.heightIn ?? 0) - (a.heightIn ?? 0));
  if (tall.length) {
    qs.push({
      id: `seven-footers-${year}`, category: "Roster", points: tall.length * 2, generated: true, source: src,
      prompt: "Name every player on this season's roster listed at 7 feet or taller, with his exact height.",
      answer: tall.map((p) => `${p.fullName} (${p.displayHeight})`).join(" · "),
      explanation: "This exact question appeared on the January 2025 entry test.",
    });
  }

  // ------------------------------------------------------------ results
  const games: Game[] = ds.games
    .filter((g) => g.season === year && g.completed && g.dukeScore !== null && g.opponentScore !== null)
    .sort(byGameDate);

  for (const g of games) {
    const where = g.neutralSite ? "on a neutral court" : g.homeAway === "away" ? "on the road" : "at home";
    qs.push({
      id: `score-${g.id}`, category: "This season", points: 1, generated: true, source: { label: "Season schedule", href: `/seasons/${year}#game-${g.id}` },
      prompt: `What was the final score when Duke played ${schoolName(g.opponent)} ${where} on ${dateFmt(g.date)}?`,
      answer: `${g.result === "W" ? "Won" : "Lost"} ${g.dukeScore}-${g.opponentScore}`,
      explanation: "The entry test asks for every opponent and final score (Duke score first). Exhibitions don't count.",
    });
  }

  const season = ds.seasons.find((s) => s.season === year);
  if (games.length) {
    const w = games.filter((g) => g.result === "W").length;
    qs.push({
      id: `record-${year}`, category: "This season", points: 2, generated: true, source: src,
      prompt: `What is Duke's overall record so far in ${label}${season?.conferenceRecord ? ", and its ACC record" : ""}?`,
      answer: `${w}-${games.length - w} overall${season?.conferenceRecord ? ` · ${season.conferenceRecord} ACC` : ""}`,
    });
    const losses = games.filter((g) => g.result === "L");
    if (losses.length) {
      qs.push({
        id: `losses-${year}`, category: "This season", points: losses.length, generated: true, source: src,
        prompt: "Which team(s) has Duke lost to this season, and by what score?",
        answer: losses.map((g) => `${schoolName(g.opponent)} ${g.opponentScore}-${g.dukeScore}`).join(" · "),
      });
    }
    const opponents = games.map((g) => schoolName(g.opponent));
    const first = games[0];
    qs.push({
      id: `opener-${year}`, category: "This season", points: 1, generated: true, source: src,
      prompt: `Who did Duke play in its ${label} season opener?`,
      answer: schoolName(first.opponent),
      choices: opponents.length >= 4 ? choicesFor(schoolName(first.opponent), opponents, `open-${year}`) : undefined,
    });
  }

  // ------------------------------------------------------------ team leaders
  const nameOf = (id: string) => ds.players.find((p) => p.id === id)?.fullName ?? id;
  const teamGames = games.length;
  const qualified = ds.seasonStats.filter((s) => s.season === year && (s.gamesPlayed ?? 0) >= Math.max(1, Math.ceil(teamGames / 2)));

  const leader = (key: string, metric: string, value: (s: PlayerSeasonStats) => number | null, digits: number, unit: string, points = 3) => {
    const ranked = qualified.filter((s) => value(s) !== null).sort((a, b) => value(b)! - value(a)!);
    if (ranked.length < 2) return;
    const top = ranked[0];
    const tie = value(ranked[1]) === value(top);
    if (tie) return; // an answer key with a tie would be ambiguous
    const ans = nameOf(top.playerId);
    qs.push({
      id: `lead-${key}-${year}`, category: "This season", points, generated: true, source: src,
      prompt: `Who leads the team in ${metric} this season?`,
      answer: ans,
      choices: choicesFor(ans, ranked.slice(1, 6).map((s) => nameOf(s.playerId)), `lead-${key}`),
      explanation: `${ans}: ${value(top)!.toFixed(digits)} ${unit} (through ${teamGames} game${teamGames === 1 ? "" : "s"}, min. half of team games played). Tests often also ask for the number itself.`,
    });
  };
  leader("ppg", "points per game", (s) => s.perGame.pts, 1, "PPG");
  leader("rpg", "rebounds per game", (s) => s.perGame.reb, 1, "RPG");
  leader("apg", "assists per game", (s) => s.perGame.ast, 1, "APG");
  leader("3pm", "3-pointers made", (s) => s.totals.tpm, 0, "made 3s");

  const best = ds.gameStats.filter((g) => g.season === year && g.pts !== null).sort((a, b) => (b.pts ?? 0) - (a.pts ?? 0));
  if (best.length > 1 && best[0].pts !== best[1].pts) {
    const g = best[0];
    qs.push({
      id: `high-game-${year}`, category: "This season", points: 3, generated: true, source: { label: "Player game log", href: `/players/${g.playerId}` },
      prompt: "Who has the highest-scoring game for Duke this season? How many points, and against whom?",
      answer: `${nameOf(g.playerId)}: ${g.pts} points ${g.atVs === "@" ? "at" : "vs."} ${g.opponent ?? "?"}`,
    });
  }

  // ------------------------------------------------------------ last season recap
  const prev = ds.seasons.find((s) => s.season === year - 1);
  if (prev && prev.wins !== null) {
    qs.push({
      id: `record-${prev.season}`, category: "This season", points: 2, generated: true, source: { label: `${prev.label} season`, href: `/seasons/${prev.season}` },
      prompt: `What was Duke's final overall record last season (${prev.label})?`,
      answer: `${prev.wins}-${prev.losses}${prev.conferenceRecord ? ` (${prev.conferenceRecord} ACC)` : ""}`,
    });
    const prevTop = ds.seasonStats.filter((s) => s.season === prev.season && (s.gamesPlayed ?? 0) >= 15 && s.perGame.pts !== null).sort((a, b) => b.perGame.pts! - a.perGame.pts!);
    if (prevTop.length > 1) {
      const ans = nameOf(prevTop[0].playerId);
      qs.push({
        id: `lead-ppg-${prev.season}`, category: "This season", points: 2, generated: true, source: { label: `${prev.label} season`, href: `/seasons/${prev.season}` },
        prompt: `Who led Duke in scoring last season (${prev.label})?`,
        answer: ans,
        choices: choicesFor(ans, prevTop.slice(1, 6).map((s) => nameOf(s.playerId)), `prevlead`),
        explanation: `${prevTop[0].perGame.pts!.toFixed(1)} points per game.`,
      });
    }
  }

  return qs;
}
