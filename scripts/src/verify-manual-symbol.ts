/**
 * Verify that a manual's chunks contain schematic symbols and PLC I/O data.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @workspace/scripts run verify:manual-symbol
 *
 * Optional:
 *   VERIFY_MANUAL_PATTERN="P2-049|PP2 049"
 *   VERIFY_SYMBOL=RL1          (single symbol — legacy)
 *   VERIFY_SYMBOLS=RL1,HL,X0  (comma-separated checklist; default PP2-049 set)
 */

import { db, manualsTable } from "@workspace/db";
import { ilike, or, sql } from "drizzle-orm";

const DEFAULT_SYMBOLS = ["RL1", "HL", "X0"];

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

async function countSymbolHits(manualId: number, symbol: string): Promise<number> {
  const hits = await db.execute<{ cnt: number }>(sql`
    SELECT COUNT(*)::int AS cnt
    FROM chunks c
    WHERE c.manual_id = ${manualId}
      AND (
        c.content ILIKE ${"%" + symbol + "%"}
        OR COALESCE(c.page_context, '') ILIKE ${"%" + symbol + "%"}
      )
  `);
  return hits.rows[0]?.cnt ?? 0;
}

async function countPlcIoTableChunks(manualId: number): Promise<number> {
  const hits = await db.execute<{ cnt: number }>(sql`
    SELECT COUNT(*)::int AS cnt
    FROM chunks c
    WHERE c.manual_id = ${manualId}
      AND (
        c.content LIKE ${"%[PLC I/O assignment%"}
        OR c.content ~* ${"\\m[XYI][0-9]+[.:][0-9]{1,2}\\M"}
      )
  `);
  return hits.rows[0]?.cnt ?? 0;
}

async function reportPageTypes(manualId: number): Promise<void> {
  const rows = await db.execute<{ page_type: string | null; cnt: number }>(sql`
    SELECT page_type, COUNT(*)::int AS cnt
    FROM manual_pages
    WHERE manual_id = ${manualId}
    GROUP BY page_type
    ORDER BY cnt DESC
  `);

  console.log("Page type breakdown (manual_pages.page_type):");
  if (rows.rows.length === 0) {
    console.log("  (no pages)");
    return;
  }
  for (const row of rows.rows) {
    const label = row.page_type ?? "(unset)";
    console.log(`  ${label}: ${row.cnt} page(s)`);
  }
  console.log("");
}

async function main() {
  const symbolsEnv = process.env.VERIFY_SYMBOLS ?? process.env.VERIFY_SYMBOL ?? DEFAULT_SYMBOLS.join(",");
  const symbols = symbolsEnv
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);

  const manual = await resolveManualId();

  if (!manual) {
    console.error("No manual matched VERIFY_MANUAL_PATTERN / VERIFY_MANUAL_ID.");
    process.exit(1);
  }

  console.log(`Manual: [${manual.id}] ${manual.name}`);
  console.log(`Checking symbols: ${symbols.join(", ")}`);
  console.log("");

  await reportPageTypes(manual.id);

  let failures = 0;

  for (const symbol of symbols) {
    const count = await countSymbolHits(manual.id, symbol);
    if (count === 0) {
      console.log(`  FAIL  ${symbol} — not found in chunks`);
      failures++;
    } else {
      console.log(`  OK    ${symbol} — ${count} chunk reference(s)`);
    }
  }

  const plcCount = await countPlcIoTableChunks(manual.id);
  if (plcCount === 0) {
    console.log(`  FAIL  PLC I/O — no I/O table rows or tagged chunks`);
    failures++;
  } else {
    console.log(`  OK    PLC I/O — ${plcCount} chunk(s) with addresses or I/O tag`);
  }

  console.log("");

  if (failures > 0) {
    console.log("Next steps on Replit:");
    console.log(`  1. git pull origin main`);
    console.log(`  2. POST /api/manuals/${manual.id}/repair-diagram-pages`);
    console.log(`     (or POST /api/manuals/${manual.id}/reprocess-vision for full OCR)`);
    console.log(`  3. Re-run: VERIFY_MANUAL_PATTERN="${process.env.VERIFY_MANUAL_PATTERN ?? "P2-049|PP2 049"}" pnpm verify:manual-symbol`);
    process.exit(1);
  }

  console.log("All PP2-049 feeder verification checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
