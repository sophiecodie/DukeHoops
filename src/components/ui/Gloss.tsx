import { lookup } from "@/lib/glossary";

const cn = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

type Align = "center" | "left" | "right";

/**
 * Renders an abbreviation with its full meaning in a tooltip on hover or keyboard focus.
 * Works in server components (pure CSS). A text with several words, like "Best PPG", has each
 * known abbreviation wrapped. Unknown text renders unchanged.
 *
 * Set `focusable={false}` inside an element that is already interactive, such as a sort button.
 * The tooltip opens below the term so that a table's scroll container doesn't clip it.
 */
export function Gloss({ text, align = "center", focusable = true, className }: { text: string; align?: Align; focusable?: boolean; className?: string }) {
  const whole = lookup(text);
  if (whole) return <Term term={text} meaning={whole} align={align} focusable={focusable} className={className} />;

  // Within running text, only match multi-character terms so a stray "C" or "W" stays plain.
  const inline = (p: string) => (p.length > 1 && p !== "vs." ? lookup(p) : undefined);
  const parts = text.split(/([\s,;:()]+)/);
  if (!parts.some(inline)) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) => {
        const m = inline(p);
        return m ? <Term key={i} term={p} meaning={m} align={align} focusable={focusable} className={className} /> : p;
      })}
    </>
  );
}

function Term({ term, meaning, align, focusable, className }: { term: string; meaning: string; align: Align; focusable: boolean; className?: string }) {
  return (
    <span className="group/gloss relative inline-block">
      <abbr
        tabIndex={focusable ? 0 : undefined}
        className={cn("cursor-help no-underline decoration-dotted decoration-1 underline-offset-[3px] [text-decoration-line:underline] focus:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-accent", className)}
      >
        {term}
      </abbr>
      <span className="sr-only"> ({meaning})</span>
      {/* Hidden with display:none (not opacity) so an off-screen tooltip can't cause page scroll. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-full z-30 mt-1.5 w-max max-w-[min(16rem,80vw)] rounded-md bg-fg px-2.5 py-1.5 text-left text-sm font-medium normal-case leading-snug tracking-normal text-bg shadow-lg",
          "hidden group-hover/gloss:block group-focus-within/gloss:block",
          // When the term sits inside a button or link, show the tooltip while that element has keyboard focus.
          !focusable && "in-focus-visible:block",
          align === "center" && "left-1/2 -translate-x-1/2",
          align === "left" && "left-0",
          align === "right" && "right-0",
        )}
      >
        <span className="font-bold">{term}</span> = {meaning}
      </span>
    </span>
  );
}
