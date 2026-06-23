/** UI mirror of api-server pipelineStages — keep stage numbers in sync. */

export const PIPELINE_COMPLETE_STAGE = 9;

const LEGACY_PASS_TO_STAGE: Record<number, number> = {
  0: 0,
  1: 1,
  2: 2,
  4: 5,
  5: 6,
  6: 8,
  7: 4,
  8: 9,
};

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
    return status === "completed" ? 8 : 4;
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
  return STAGE_PROGRESS_PCT[normalizeProcessingPass(pass, stageVersion, status)] ?? 5;
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

export function showGraphRepairButton(
  pass: number | null | undefined,
  stageVersion?: number | null,
  status?: string | null
): boolean {
  const normalized = normalizeProcessingPass(pass, stageVersion, status);
  return normalized >= 5 && normalized < 8;
}
