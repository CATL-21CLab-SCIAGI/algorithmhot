import { titled } from "../lib/seo";
import { SITE, withSubject } from "@aihot/industry/site";
import { SearchBusy } from "./all";

export function meta() {
  return [{ title: titled("搜索繁忙") }, { name: "robots", content: "noindex, follow" }];
}

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default SearchBusy;
