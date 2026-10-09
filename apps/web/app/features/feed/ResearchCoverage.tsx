import type { ResearchDayCoverage } from "@aihot/contracts/research-coverage";

/** Private SSR consistency marker; the static exporter verifies and removes it. */
export function ResearchCoverage({ days }: { days: ResearchDayCoverage[] }) {
  if (!days.length) return null;
  return <div hidden data-research-coverage={JSON.stringify(days)} />;
}
