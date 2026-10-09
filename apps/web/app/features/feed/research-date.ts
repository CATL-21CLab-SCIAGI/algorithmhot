import type { ResearchMetadata } from "@aihot/contracts/research";
import { beijingDate, isValidDate } from "@aihot/contracts/time";

type DatedResearch = {
  research?: Pick<ResearchMetadata, "arxivId"> & Partial<Pick<ResearchMetadata, "announcedOn" | "originalPublishedAt">> | null;
  publishedAt?: string | null;
  timelineAt: string;
};

function validTimestamp(value: string | null | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** The source date used for reader ordering; announcement and observation are separate evidence. */
export function originalPublicationAt(item: Pick<DatedResearch, "research">): string | null {
  const value = item.research?.originalPublishedAt;
  return validTimestamp(value) ? value : null;
}

/** An official announcement is a calendar date, not the time the collector first saw it. */
export function announcementDay(item: Pick<DatedResearch, "research">): string | null {
  const day = item.research?.arxivId ? item.research.announcedOn : null;
  return day && isValidDate(day) ? day : null;
}

/**
 * Date used by the visible reader rail. Unknown arXiv submission dates stay unknown: the
 * observation timeline keeps the item reachable but is never presented as its source date.
 */
export function readerTimelineAt(item: DatedResearch): string {
  const original = originalPublicationAt(item);
  if (original) return original;
  if (item.research?.arxivId) return item.timelineAt;
  return validTimestamp(item.publishedAt) ? item.publishedAt : item.timelineAt;
}

/** Beijing calendar day for reader grouping; unknown arXiv dates use an explicit unknown label. */
export function readerDay(item: DatedResearch): string {
  return beijingDate(readerTimelineAt(item));
}

export function readerDateKnown(item: DatedResearch): boolean {
  return !!originalPublicationAt(item) || !item.research?.arxivId;
}
