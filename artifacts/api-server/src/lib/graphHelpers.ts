import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Run a batch query to find the dominant Docling section_path for each entity.
 *
 * Joins entities → chunks by manual_id + page_number overlap with the entity's
 * extraction page range, then picks the most-frequent section_path per entity.
 * Entities backed only by pdf-parse chunks (section_path IS NULL) are absent
 * from the returned map.
 *
 * @param manualId  If supplied, limits the query to a single manual.
 */
export async function buildSectionMap(
  manualId?: number
): Promise<Map<number, string>> {
  const filter =
    manualId != null ? `WHERE e.manual_id = ${manualId}` : "";

  const rows = await db.execute<{ entity_id: number; section_path: string }>(
    sql.raw(`
      WITH counts AS (
        SELECT
          e.id          AS entity_id,
          c.section_path,
          COUNT(*)      AS cnt
        FROM entities e
        JOIN chunks c
          ON  c.manual_id    = e.manual_id
          AND c.section_path IS NOT NULL
          AND c.page_number  >= COALESCE(e.extraction_start_page, -1)
          AND c.page_number  <= COALESCE(e.extraction_end_page,   99999)
        ${filter}
        GROUP BY e.id, c.section_path
      ),
      ranked AS (
        SELECT entity_id, section_path,
               ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY cnt DESC) AS rn
        FROM counts
      )
      SELECT entity_id, section_path FROM ranked WHERE rn = 1
    `)
  );

  const map = new Map<number, string>();
  for (const row of rows.rows) map.set(row.entity_id, row.section_path);
  return map;
}
