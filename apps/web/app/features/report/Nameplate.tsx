// The report nameplates (industry/brand/nameplates/, made by scripts/nameplates.ts from the pack's
// subject word). Each logotype is cached on its own; the two paths take the theme's ink and accent.
import daily from "@aihot/industry/brand/nameplates/daily.svg?url&no-inline";
import weekly from "@aihot/industry/brand/nameplates/weekly.svg?url&no-inline";
import monthly from "@aihot/industry/brand/nameplates/monthly.svg?url&no-inline";
import archive from "@aihot/industry/brand/nameplates/archive.svg?url&no-inline";
import viewBoxes from "@aihot/industry/brand/nameplates/index.json";

const NAMEPLATES = {
  daily: { url: daily, viewBox: viewBoxes.daily },
  weekly: { url: weekly, viewBox: viewBoxes.weekly },
  monthly: { url: monthly, viewBox: viewBoxes.monthly },
  archive: { url: archive, viewBox: viewBoxes.archive },
} as const;

export function Nameplate({ which, className = "" }: { which: keyof typeof NAMEPLATES | "pilot"; className?: string }) {
  if (which === "pilot") return (
    <svg viewBox="0 0 420 110" className={className} aria-hidden="true" focusable="false">
      <text x="0" y="88" fontSize="96" fontWeight="900" className="fill-accent">科研</text>
      <text x="199" y="88" fontSize="96" fontWeight="900" className="fill-ink">试刊</text>
    </svg>
  );
  const n = NAMEPLATES[which];
  return (
    <svg viewBox={n.viewBox} className={className} aria-hidden="true" focusable="false">
      <use href={`${n.url}#accent`} className="fill-accent" />
      <use href={`${n.url}#ink`} className="fill-ink" />
    </svg>
  );
}
