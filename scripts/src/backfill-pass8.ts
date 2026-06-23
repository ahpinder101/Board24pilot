/**
 * One-time backfill: run Pass 8 chunk enrichment on all completed manuals
 * that have not yet been enriched (processingPass < 8 or NULL).
 *
 * Idempotent: skips manuals that already have processingPass >= 8.
 * Safe to re-run; pass8EnrichChunks uses page_context NULL as a resume marker.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill-pass8
 */

import { db } from "@workspace/db";
import { manualsTable } from "@workspace/db";
import { eq, and, or, isNull, lt, sql } from "drizzle-orm";

// Relative import — tsx resolves .js → .ts from the file's own location.
import { pass8EnrichChunks } from "../../artifacts/api-server/src/lib/extractionPipeline.js";

async function main() {
  console.log("=== Pass 8 backfill starting ===");

  const manuals = await db
    .select({ id: manualsTable.id, name: manualsTable.name, processingPass: manualsTable.processingPass })
    .from(manualsTable)
    .where(
      and(
        eq(manualsTable.status, "completed"),
        or(isNull(manualsTable.processingPass), lt(manualsTable.processingPass, 8))
      )
    )
    .orderBy(manualsTable.id);

  if (manuals.length === 0) {
    console.log("No manuals need enrichment. All completed manuals already have processingPass >= 8.");
    return;
  }

  console.log(`Found ${manuals.length} manual(s) to enrich:`);
  for (const m of manuals) {
    console.log(`  - Manual ${m.id}: "${m.name}" (processingPass=${m.processingPass ?? "NULL"})`);
  }
  console.log();

  let succeeded = 0;
  let failed = 0;

  for (const manual of manuals) {
    const { id, name } = manual;
    console.log(`[${id}] "${name}" — starting Pass 8 enrichment...`);
    try {
      const result = await pass8EnrichChunks(id);
      await db
        .update(manualsTable)
        .set({ processingPass: 8, updatedAt: new Date() })
        .where(eq(manualsTable.id, id));
      console.log(
        `[${id}] "${name}" — done. enriched=${result.enriched} stitched=${result.stitched} expansions=${result.expansions}`
      );
      succeeded++;
    } catch (err) {
      console.error(`[${id}] "${name}" — FAILED:`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  console.log();
  console.log(`=== Pass 8 backfill complete: ${succeeded} succeeded, ${failed} failed ===`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
