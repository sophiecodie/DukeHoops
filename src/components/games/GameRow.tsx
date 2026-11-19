import type { Game } from "@/lib/types";
import { formatGameDay } from "@/lib/dates";
import { Badge, cn } from "@/components/ui/primitives";

export function formatGameDate(iso: string | null, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  return formatGameDay(iso, opts) ?? "TBD";
}

function tipTime(game: Game): string {
  if (!game.date) return "TBD";
  if (game.timeUnknown) return "Time unknown";
  return new Date(game.date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
}

export function GameRow({ game, showYear = false }: { game: Game; showYear?: boolean }) {
  const prefix = game.neutralSite ? "vs." : game.homeAway === "away" ? "@" : "vs.";
  return (
    <div id={`game-${game.id}`} className="flex scroll-mt-24 items-center gap-3 py-2.5 text-sm">
      <span className="tabular w-16 shrink-0 text-muted">{formatGameDate(game.date, showYear ? { month: "short", day: "numeric", year: "2-digit" } : undefined)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-fg">
          <abbr title={prefix === "@" ? "Away game" : game.neutralSite ? "Neutral-site game" : "Home game"} className="cursor-help no-underline">{prefix}</abbr> {game.opponent ?? "Unknown opponent"}
        </span>
        {(game.note || game.isCurated) && (
          <span className="block truncate text-xs text-muted">
            {game.note}
            {game.isCurated && (
              <>
                {game.note && " · "}
                <abbr title={`Missing from ESPN's feed; added from ${game.source.name.replace(/^Curated: /, "")}`} className="cursor-help no-underline">
                  curated
                </abbr>
                {game.timeUnknown && " · time unknown"}
              </>
            )}
          </span>
        )}
      </span>
      {game.seasonType === "postseason" && <Badge tone="brand">Postseason</Badge>}
      {game.result ? (
        <span className={cn("tabular w-24 shrink-0 text-right font-bold", game.result === "W" ? "text-success" : "text-danger")}>
          {game.result} {game.dukeScore}-{game.opponentScore}
        </span>
      ) : (
        <span className="w-20 shrink-0 text-right text-xs text-muted">{tipTime(game)}</span>
      )}
    </div>
  );
}
