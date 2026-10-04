import type { StoryFollowupsResponse } from "@aihot/contracts/site";
import { loadDevelopments } from "./groups.ts";

/** A short reading-page list, using the same publication/filter rules as the full event. */
export async function loadStoryFollowups(storyPublicId: string): Promise<StoryFollowupsResponse | null> {
  const result = await loadDevelopments({ storyPublicId, channel: "all", category: null, tag: null, topicTags: null, cursor: null, revision: null, take: 8 });
  if (result.kind !== "ok") return null;
  return { items: result.body.developments.map(({ factId, representative: r }) => ({ factId, representative: { id: r.id, title: r.title, source: { name: r.source.name }, timelineAt: r.timelineAt } })), more: !!result.body.nextCursor };
}
