import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, Trophy } from "lucide-react";
import { getSeasonDetail, listSeasons } from "@/lib/data/queries";
import { fmt, fmtInt, fmtPct, seasonLabel } from "@/lib/stats";
import { Badge, Card, CardHeader, DataNote, EmptyState, StatTile } from "@/components/ui/primitives";
import { GameRow } from "@/components/games/GameRow";
import { PlayerAvatar } from "@/components/players/PlayerAvatar";
import { Gloss } from "@/components/ui/Gloss";

export const revalidate = 600;

export async function generateStaticParams() {
  return (await listSeasons()).map((s) => ({ season: String(s.season) }));
}

export async function generateMetadata({ params }: PageProps<"/seasons/[season]">): Promise<Metadata> {
  const y = Number((await params).season);
  return { title: Number.isInteger(y) ? `${seasonLabel(y)} season` : "Season" };
}

export default async function SeasonPage({ params }: PageProps<"/seasons/[season]">) {
  const year = Number((await params).season);
  if (!Number.isInteger(year)) notFound();
  const detail = await getSeasonDetail(year);
  if (!detail) notFound();
  const { season, roster, games, champion, prev, next, topGames } = detail;

  const done = games.filter((g) => g.result);
  const pf = done.reduce((a, g) => a + (g.dukeScore ?? 0), 0);
  const pa = done.reduce((a, g) => a + (g.opponentScore ?? 0), 0);
  const home = done.filter((g) => g.homeAway === "home" && !g.neutralSite);
  const homeW = home.filter((g) => g.result === "W").length;
  const post = games.filter((g) => g.seasonType === "postseason");

  const navBtn = "inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-2";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="text-sm text-muted"><Link href="/seasons" className="hover:underline">Seasons</Link> / <span className="text-fg">{season.label}</span></nav>
        <div className="flex gap-2">
          {prev && <Link href={`/seasons/${prev}`} className={navBtn}><ChevronLeft className="h-4 w-4" /> {seasonLabel(prev)}</Link>}
          {next && <Link href={`/seasons/${next}`} className={navBtn}>{seasonLabel(next)} <ChevronRight className="h-4 w-4" /></Link>}
        </div>
      </div>

      <header className="rounded-2xl bg-gradient-to-br from-duke-navy to-duke-royal px-6 py-8 text-white">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold">{season.label} Duke Blue Devils</h1>
          {champion && <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-3 py-1 text-sm font-medium"><Trophy className="h-4 w-4" /> National champions</span>}
        </div>
        <p className="mt-2 text-white/80">Head coach: {season.coach ?? "—"}{season.coachIsCurated && " (curated)"}</p>
      </header>

      <section aria-label="Season summary" className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile label="Overall" value={season.wins !== null ? `${season.wins}-${season.losses}` : "—"} hint={season.recordIsComputed ? "Computed from results" : undefined} />
        <StatTile label="ACC" value={season.conferenceRecord ?? "—"} hint={season.conferenceRecordIsCurated ? "Curated (not in ESPN's feed)" : undefined} />
        <StatTile label="Home" value={home.length ? `${homeW}-${home.length - homeW}` : "—"} />
        <StatTile label="Points / game" value={done.length ? fmt(pf / done.length) : "—"} />
        <StatTile label="Allowed / game" value={done.length ? fmt(pa / done.length) : "—"} hint={done.length ? `Margin ${fmt((pf - pa) / done.length)}` : undefined} />
      </section>

      <Card>
        <CardHeader title="Roster & player statistics" subtitle="Per-game averages, sorted by scoring" />
        {roster.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-surface-2 text-sm font-bold uppercase tracking-wide text-fg">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-left">Player</th>
                  {["GP", "MIN", "PTS", "REB", "AST", "STL", "BLK", "FG%", "3P%", "FT%"].map((h) => <th key={h} scope="col" className="px-3 py-2.5 text-right"><Gloss text={h} align="right" /></th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {roster.map(({ player, jersey, stats }) => (
                  <tr key={player.id} className="hover:bg-surface-2">
                    <td className="px-4 py-2">
                      <Link href={`/players/${player.id}`} className="flex items-center gap-2.5">
                        <PlayerAvatar name={player.fullName} src={player.headshotUrl} size={28} />
                        <span className="font-semibold hover:underline">{player.fullName}</span>
                        <span className="text-sm text-muted">#{jersey ?? "—"}</span>
                      </Link>
                    </td>
                    <td className="tabular px-3 py-2 text-right">{fmtInt(stats?.gamesPlayed)}</td>
                    <td className="tabular px-3 py-2 text-right">{fmt(stats?.perGame.min)}</td>
                    <td className="tabular px-3 py-2 text-right font-semibold">{fmt(stats?.perGame.pts)}</td>
                    <td className="tabular px-3 py-2 text-right">{fmt(stats?.perGame.reb)}</td>
                    <td className="tabular px-3 py-2 text-right">{fmt(stats?.perGame.ast)}</td>
                    <td className="tabular px-3 py-2 text-right">{fmt(stats?.perGame.stl)}</td>
                    <td className="tabular px-3 py-2 text-right">{fmt(stats?.perGame.blk)}</td>
                    <td className="tabular px-3 py-2 text-right">{fmtPct(stats?.shooting.fgPct)}</td>
                    <td className="tabular px-3 py-2 text-right">{fmtPct(stats?.shooting.tpPct)}</td>
                    <td className="tabular px-3 py-2 text-right">{fmtPct(stats?.shooting.ftPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-5"><EmptyState title="No roster data for this season" /></div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Schedule & results" subtitle={`${games.length} games${post.length ? ` · ${post.length} postseason` : ""}`} />
          {games.length ? (
            <div className="divide-y divide-border px-5">{games.map((g) => <GameRow key={g.id} game={g} />)}</div>
          ) : (
            <div className="p-5"><EmptyState title="No schedule data" /></div>
          )}
        </Card>
        <Card>
          <CardHeader title="Top individual games" subtitle="By points, from game logs" />
          {topGames.length ? (
            <ol className="divide-y divide-border">
              {topGames.map((g) => (
                <li key={`${g.playerId}-${g.gameId}`} className="px-5 py-3 text-sm">
                  <Link href={`/players/${g.playerId}`} className="font-medium text-fg hover:underline">{g.playerName}</Link>
                  <span className="tabular float-right font-semibold">{g.pts} pts</span>
                  <span className="block text-xs text-muted">{g.atVs} {g.opponent} · {g.date?.slice(0, 10)} · <Badge tone={g.result === "W" ? "success" : "danger"}>{g.result}</Badge></span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="p-5"><EmptyState title="No game logs for this season">Game-level box scores are currently ingested for the three most recent seasons.</EmptyState></div>
          )}
        </Card>
      </div>

      <DataNote>Source: <a className="underline" href={season.source.url} target="_blank" rel="noopener noreferrer">ESPN schedule feed</a>, retrieved {new Date(season.source.retrievedAt).toLocaleDateString()}.
        {(season.conferenceRecordIsCurated || games.some((g) => g.isCurated)) && (
          <> Data marked &ldquo;curated&rdquo; is missing from ESPN&rsquo;s feed and was added by hand from Sports-Reference and GoDuke.com (see <code>data/curated/game_corrections.json</code>).</>
        )}{" "}
        News and historical context for each season are planned (see TODO.md).</DataNote>
    </div>
  );
}
