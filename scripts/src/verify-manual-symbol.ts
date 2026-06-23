/**
 * Verify that a manual's chunks contain a schematic symbol (e.g. RL1).
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @workspace/scripts run verify:manual-symbol
 *
 * Optional:
 *   VERIFY_MANUAL_PATTERN="P2-049|PP2 049"
 *   VERIFY_SYMBOL=RL1
 */

import { db, manualsTable } from "@workspace/db";
import { ilike, or, sql } from "drizzle-orm";

async function resolveManualId(): Promise<{ id: number; name: string } | null> {
  const explicitId = Number(process.env.VERIFY_MANUAL_ID ?? "");
  if (Number.isInteger(explicitId) && explicitId > 0) {
    const [row] = await db
      .select({ id: manualsTable.id, name: manualsTable.name })
      .from(manualsTable)
      .where(sql`${manualsTable.id} = ${explicitId}`)
      .limit(1);
    return row ?? null;
  }

  const pattern = process.env.VERIFY_MANUAL_PATTERN ?? "P2-049|PP2 049";
  const fragments = pattern
    .split("|")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (fragments.length === 0) return null;

  const clauses = fragments.map((fragment) => ilike(manualsTable.name, `%${fragment}%`));
  const matches = await db
    .select({ id: manualsTable.id, name: manualsTable.name })
    .from(manualsTable)
    .where(clauses.length === 1 ? clauses[0]! : or(...clauses))
    .limit(5);

  if (matches.length === 0) return null;
  return matches[0]!;
}

async function main() {
  const symbol = (process.env.VERIFY_SYMBOL ?? "RL1").toUpperCase();
  const manual = await resolveManualId();

  if (!manual) {
    console.error("No manual matched VERIFY_MANUAL_PATTERN / VERIFY_MANUAL_ID.");
    process.exit(1);
  }

  console.log(`Manual: [${manual.id}] ${manual.name}`);
  console.log(`Symbol: ${symbol}`);
  console.log("");

  const hits = await db.execute<{
    page_number: number;
    chunk_index: number;
    preview: string;
  }>(sql`
    SELECT c.page_number, c.chunk_index, left(c.content, 160) AS preview
    FROM chunks c
    WHERE c.manual_id = ${manual.id}
      AND (
        c.content ILIKE ${"%" + symbol + "%"}
        OR COALESCE(c.page_context, '') ILIKE ${"%" + symbol + "%"}
      )
    ORDER BY c.page_number, c.chunk_index
    LIMIT 20
  `);

  if (hits.rows.length === 0) {
    console.log(`No chunks contain "${symbol}".`);
    console.log("");
    console.log("Next steps on Replit:");
    console.log(`  1. git pull origin main`);
    console.log(`  2. POST /api/manuals/${manual.id}/repair-diagram-pages`);
    console.log(`     (or POST /api/manuals/${manual.id}/reprocess-vision for full OCR)`);
    process.exit(1);
  }

  console.log(`Found ${hits.rows.length} chunk(s) referencing ${symbol}:`);
  for (const row of hits.rows) {
    console.log(`  page ${row.page_number}, chunk ${row.chunk_index}: ${row.preview.replace(/\s+/g, " ").slice(0, 120)}...`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
