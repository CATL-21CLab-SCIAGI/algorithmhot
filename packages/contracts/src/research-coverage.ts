/** An audited calendar-day source check, independent of model processing and paper publication. */
export interface ResearchDayCoverage {
  date: string;
  timezone: "Asia/Shanghai";
  checkedAt: string;
  status: "checked-empty" | "has-records" | "partial";
  articleCount: number;
  signalCount: number;
  note: string;
  sources: Array<{
    id: string;
    name: string;
    observedAt: string;
    status: "checked-empty" | "has-records" | "unavailable";
    articleCount: number | null;
    signalCount: number | null;
    urls: string[];
    note: string;
  }>;
}
