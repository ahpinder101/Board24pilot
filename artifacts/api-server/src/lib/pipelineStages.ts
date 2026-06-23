/**
 * Extraction pipeline stages (0–9) in runtime execution order.
 *
 * 0 parse_layout          — compute (Docling / pdf-parse)
 * 1 profile_document      — LLM
 * 2 index_pages           — compute
 * 3 vision_interpret      — LLM + compute
 * 4 build_chunks          — mixed
 * 5 extract_entities      — LLM
 * 6 extract_relationships — LLM
 * 7 extract_paths         — LLM
 * 8 rank_hierarchy        — LLM
 * 9 enrich_chunks         — mixed
 */

export const PIPELINE_STAGE = {
  PARSE_LAYOUT: 0,
  PROFILE_DOCUMENT: 1,
  INDEX_PAGES: 2,
  VISION_INTERPRET: 3,
  BUILD_CHUNKS: 4,
  EXTRACT_ENTITIES: 5,
  EXTRACT_RELATIONSHIPS: 6,
  EXTRACT_PATHS: 7,
  RANK_HIERARCHY: 8,
  ENRICH_CHUNKS: 9,
} as const;

export type PipelineStage = (typeof PIPELINE_STAGE)[keyof typeof PIPELINE_STAGE];

/** Highest stage number — pipeline complete when processingPass >= this. */
export const PIPELINE_COMPLETE_STAGE = PIPELINE_STAGE.ENRICH_CHUNKS;

export const STAGE_ID: Record<number, string> = {
  0: "parse_layout",
  1: "profile_document",
  2: "index_pages",
  3: "vision_interpret",
  4: "build_chunks",
  5: "extract_entities",
  6: "extract_relationships",
  7: "extract_paths",
  8: "rank_hierarchy",
  9: "enrich_chunks",
};

export const STAGE_LABEL: Record<number, string> = {
  0: "Parse layout",
  1: "Profile document",
  2: "Index pages",
  3: "Vision interpret",
  4: "Build chunks",
  5: "Extract entities",
  6: "Extract relationships",
  7: "Extract paths",
  8: "Rank hierarchy",
  9: "Enrich chunks",
};

/** UI progress bar weights (0–100). */
export const STAGE_PROGRESS_PCT: Record<number, number> = {
  0: 5,
  1: 12,
  2: 18,
  3: 28,
  4: 42,
  5: 55,
  6: 68,
  7: 78,
  8: 88,
  9: 100,
};

/** Map legacy processingPass values (pre-rename) to new stage numbers. */
const LEGACY_PASS_TO_STAGE: Record<number, PipelineStage> = {
  0: 0,
  1: 1,
  2: 2,
  4: 5,
  5: 6,
  6: 8,
  7: 4,
  8: 9,
};

export function normalizeProcessingPass(
  pass: number | null | undefined,
  stageVersion: number | null | undefined = 2,
  status?: string | null
): number {
  if (pass == null || pass < 0) return 0;

  if ((stageVersion ?? 2) >= 2) {
    return Math.min(pass, PIPELINE_COMPLETE_STAGE);
  }

  if (pass <= 2) return pass;

  if (pass === 7) {
    return status === "completed"
      ? PIPELINE_STAGE.RANK_HIERARCHY
      : PIPELINE_STAGE.BUILD_CHUNKS;
  }

  if (pass in LEGACY_PASS_TO_STAGE) {
    return LEGACY_PASS_TO_STAGE[pass]!;
  }

  return Math.min(pass, PIPELINE_COMPLETE_STAGE);
}

export function stageProgressPercent(
  pass: number | null | undefined,
  stageVersion?: number | null,
  status?: string | null
): number {
  const normalized = normalizeProcessingPass(pass, stageVersion, status);
  return STAGE_PROGRESS_PCT[normalized] ?? 5;
}

export function formatStageProgress(
  pass: number | null | undefined,
  stageVersion?: number | null,
  status?: string | null
): string {
  const normalized = normalizeProcessingPass(pass, stageVersion, status);
  const label = STAGE_ID[normalized] ?? "parse_layout";
  return `${label} (${normalized}/${PIPELINE_COMPLETE_STAGE})`;
}

export function isPipelineComplete(
  pass: number | null | undefined,
  stageVersion?: number | null,
  status?: string | null
): boolean {
  return normalizeProcessingPass(pass, stageVersion, status) >= PIPELINE_COMPLETE_STAGE;
}

export function hasCompletedEntityExtraction(
  pass: number | null | undefined,
  stageVersion?: number | null,
  status?: string | null
): boolean {
  return normalizeProcessingPass(pass, stageVersion, status) >= PIPELINE_STAGE.EXTRACT_RELATIONSHIPS;
}

export function hasCompletedChunkBuild(
  pass: number | null | undefined,
  stageVersion?: number | null,
  status?: string | null
): boolean {
  return normalizeProcessingPass(pass, stageVersion, status) >= PIPELINE_STAGE.BUILD_CHUNKS;
}

export function showGraphRepairButton(
  pass: number | null | undefined,
  stageVersion?: number | null,
  status?: string | null
): boolean {
  const normalized = normalizeProcessingPass(pass, stageVersion, status);
  return (
    normalized >= PIPELINE_STAGE.EXTRACT_ENTITIES &&
    normalized < PIPELINE_STAGE.RANK_HIERARCHY
  );
}
