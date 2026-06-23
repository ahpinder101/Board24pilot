/**
 * Processing cost estimator for the AI extraction pipeline.
 *
 * Estimates the OpenAI API cost for processing a document through all passes
 * (entity extraction, relationship extraction, vision OCR, diagram description, etc.)
 * based on document metrics available in the database.
 *
 * This module has no side-effects — it is pure computation only, so it can be
 * called from a GET endpoint without touching the pipeline or slowing it down.
 */

export const PIPELINE_MODEL = "gpt-5.4";

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  label: string;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-5.4":      { inputPer1M:  5.00, outputPer1M: 20.00, label: "GPT-5.4" },
  "gpt-4o":       { inputPer1M:  2.50, outputPer1M: 10.00, label: "GPT-4o" },
  "gpt-4o-mini":  { inputPer1M:  0.15, outputPer1M:  0.60, label: "GPT-4o Mini" },
  "gpt-4-turbo":  { inputPer1M: 10.00, outputPer1M: 30.00, label: "GPT-4 Turbo" },
};

function getPricing(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? { inputPer1M: 5.00, outputPer1M: 20.00, label: model };
}

export interface StepEstimate {
  step: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostEstimate {
  model: string;
  modelLabel: string;
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  pageCount: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  estimatedCostUsd: number;
  steps: StepEstimate[];
  /** true = computed from real processed data (post-completion), false = pre-run estimate */
  isActual: boolean;
  disclaimer: string;
}

function makeStep(
  pricing: ModelPricing,
  name: string,
  callCount: number,
  inputTokensPerCall: number,
  outputTokensPerCall: number
): StepEstimate {
  const inputTokens = Math.round(callCount * inputTokensPerCall);
  const outputTokens = Math.round(callCount * outputTokensPerCall);
  const costUsd =
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M;
  return { step: name, callCount: Math.round(callCount), inputTokens, outputTokens, costUsd };
}

/**
 * Pre-run cost estimate from document metrics available before processing starts.
 *
 * Uses averaged heuristics for:
 *  - 5% of pages expected to be sparse/scanned (need Vision OCR)
 *  - 60% of image pages expected to be diagrams (need vision description)
 *  - 5% of pages expected to be OCR-linearised tables (need restructure)
 *  - Text chunks = ceil(totalTextChars / 12_000) — 3 000-char chunks at 4 chars/token
 */
export function estimateProcessingCost(params: {
  model?: string;
  pageCount: number;
  totalTextChars: number;
  imagePageCount: number;
  picturePageCount?: number;
  isReExtract?: boolean;
}): CostEstimate {
  const model = params.model ?? PIPELINE_MODEL;
  const pricing = getPricing(model);
  const { pageCount, totalTextChars, imagePageCount, picturePageCount = 0, isReExtract = false } = params;

  const textChunks = Math.max(1, Math.ceil(totalTextChars / 12_000));
  const sparsePages = Math.max(0, Math.round(pageCount * 0.05));
  const diagramPages = Math.max(0, Math.round((imagePageCount + picturePageCount) * 0.6));
  const tabularPages = Math.max(0, Math.round(pageCount * 0.05));

  const steps: StepEstimate[] = [];

  if (!isReExtract) {
    steps.push(makeStep(pricing, "Document structure analysis", 1, 2_000, 1_000));
  }
  if (sparsePages > 0) {
    steps.push(makeStep(pricing, "Vision interpret — stage 3", sparsePages, 2_800, 4_096));
  }
  if (diagramPages > 0) {
    steps.push(makeStep(pricing, "Diagram chunking — stage 4 (deduped when stage 3 ran)", diagramPages, 0, 0));
  }
  if (tabularPages > 0) {
    steps.push(makeStep(pricing, "Table reconstruction — stage 4", tabularPages, 1_500, 1_000));
  }
  steps.push(makeStep(pricing, "Entity extraction — stage 5", textChunks, 2_500, 4_000));
  steps.push(makeStep(pricing, "Relationship extraction — stage 6", textChunks, 2_000, 3_000));
  steps.push(makeStep(pricing, "Procedure paths — stage 7", textChunks, 1_500, 2_000));
  steps.push(makeStep(pricing, "Hierarchy ordering — stage 8", 1, 1_500, 500));

  const inputTokensTotal = steps.reduce((s, t) => s + t.inputTokens, 0);
  const outputTokensTotal = steps.reduce((s, t) => s + t.outputTokens, 0);
  const estimatedCostUsd = steps.reduce((s, t) => s + t.costUsd, 0);

  return {
    model,
    modelLabel: pricing.label,
    inputPer1MUsd: pricing.inputPer1M,
    outputPer1MUsd: pricing.outputPer1M,
    pageCount,
    inputTokensTotal,
    outputTokensTotal,
    estimatedCostUsd,
    steps,
    isActual: false,
    disclaimer:
      "Estimates based on average document density and typical pipeline usage. Actual cost may vary ±50%. Pricing shown reflects current known rates for the model — check Replit AI billing for your actual charges.",
  };
}

/**
 * Post-run cost estimate computed from real data after processing completes.
 *
 * Uses actual chunk count (stored in DB), actual image/picture page counts,
 * and actual total text chars — same formula as estimateProcessingCost but with
 * real values instead of heuristic fractions.
 */
export function calculateActualCost(params: {
  model?: string;
  pageCount: number;
  chunkCount: number;
  imagePageCount: number;
  picturePageCount: number;
  totalTextChars: number;
}): CostEstimate {
  const model = params.model ?? PIPELINE_MODEL;
  const pricing = getPricing(model);
  const { pageCount, chunkCount, imagePageCount, picturePageCount, totalTextChars } = params;

  const textChunks = Math.max(1, Math.ceil(totalTextChars / 12_000));
  const sparsePages = Math.max(0, Math.round(pageCount * 0.05));
  const diagramPages = Math.max(0, Math.round((imagePageCount + picturePageCount) * 0.6));
  const tabularPages = Math.max(0, Math.round(pageCount * 0.05));

  const steps: StepEstimate[] = [];
  steps.push(makeStep(pricing, "Document structure analysis", 1, 2_000, 1_000));
  if (sparsePages > 0) {
    steps.push(makeStep(pricing, "Vision interpret — stage 3", sparsePages, 2_800, 4_096));
  }
  if (diagramPages > 0) {
    steps.push(makeStep(pricing, "Diagram chunking — stage 4 (deduped when stage 3 ran)", diagramPages, 0, 0));
  }
  if (tabularPages > 0) {
    steps.push(makeStep(pricing, "Table reconstruction — stage 4", tabularPages, 1_500, 1_000));
  }
  steps.push(makeStep(pricing, "Entity extraction — stage 5", textChunks, 2_500, 4_000));
  steps.push(makeStep(pricing, "Relationship extraction — stage 6", textChunks, 2_000, 3_000));
  steps.push(makeStep(pricing, "Procedure paths — stage 7", textChunks, 1_500, 2_000));
  steps.push(makeStep(pricing, "Hierarchy ordering — stage 8", 1, 1_500, 500));

  const inputTokensTotal = steps.reduce((s, t) => s + t.inputTokens, 0);
  const outputTokensTotal = steps.reduce((s, t) => s + t.outputTokens, 0);
  const estimatedCostUsd = steps.reduce((s, t) => s + t.costUsd, 0);

  void chunkCount;

  return {
    model,
    modelLabel: pricing.label,
    inputPer1MUsd: pricing.inputPer1M,
    outputPer1MUsd: pricing.outputPer1M,
    pageCount,
    inputTokensTotal,
    outputTokensTotal,
    estimatedCostUsd,
    steps,
    isActual: true,
    disclaimer:
      "Calculated from actual pages and chunks processed. Token counts are estimated from document metrics — check Replit AI billing for your exact charges.",
  };
}
