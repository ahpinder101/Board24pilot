/**
 * One-time backfill: run enrich_chunks (stage 9) on completed manuals
 * that have not yet been enriched.
 *
 * Idempotent: skips manuals that already have processingPass >= 9 (or legacy pass 8).
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill-pass8
 */

import { db } from "@workspace/db";
import { manualsTable } from "@workspace/db";
import { eq, and, or, isNull, lt, sql } from "drizzle-orm";
import { PIPELINE_COMPLETE_STAGE } from "../../artifacts/api-server/src/lib/pipelineStages.js";

import { pass8EnrichChunks } from "../../artifacts/api-server/src/lib/extractionPipeline.js";

async function main() {
  console.log("=== Stage 9 (enrich_chunks) backfill starting ===");

  const manuals = await db
    .select({ id: manualsTable.id, name: manualsTable.name, processingPass: manualsTable.processingPass })
    .from(manualsTable)
    .where(
      and(
        eq(manualsTable.status, "completed"),
        or(
          isNull(manualsTable.processingPass),
          lt(manualsTable.processingPass, PIPELINE_COMPLETE_STAGE),
          // Legacy manuals marked complete at pass 8
          sql`(${manualsTable.processingPass} = 8 AND COALESCE(${manualsTable.pipelineStageVersion}, 1) < 2)`
        )
      )
    )
    .orderBy(manualsTable.id);

  if (manuals.length === 0) {
    console.log("No manuals need enrichment.");
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
    console.log(`[${id}] "${name}" — starting enrich_chunks...`);
    try {
      const result = await pass8EnrichChunks(id);
      await db
        .update(manualsTable)
        .set({ processingPass: PIPELINE_COMPLETE_STAGE, pipelineStageVersion: 2, updatedAt: new Date() })
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
  console.log(`=== Stage 9 backfill complete: ${succeeded} succeeded, ${failed} failed ===`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
