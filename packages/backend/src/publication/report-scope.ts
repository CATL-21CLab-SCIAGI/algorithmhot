import { sql } from "../db.ts";

/** An opted-in edition becomes public when its saved daily sections contain an item. */
export function publicReportCondition(table = "reports") {
  return sql`(NOT ${sql(`${table}.hide_when_empty`)} OR jsonb_path_exists(${sql(`${table}.content`)},
    '$ ? (@.sections.type() == "array").sections[*] ? (@.items.type() == "array").items[*] ? (@.type() == "object")'))`;
}
