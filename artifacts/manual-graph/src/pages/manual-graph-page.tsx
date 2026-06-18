import { useParams } from "wouter";
import {
  useGetManual,
  useGetManualGraph,
  useGetManualStats,
  getGetManualQueryKey,
  getGetManualGraphQueryKey,
  getGetManualStatsQueryKey,
} from "@workspace/api-client-react";
import { GraphView } from "@/components/graph-view";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import {
  Clock, CheckCircle2, AlertTriangle, FileText, Database, Network,
  Layers, Play, Lightbulb, DollarSign, Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

// ─── Token-based cost model ────────────────────────────────────────────────────
//
// Computed from actual prompt character counts in extractionPipeline.ts:
//
//  Pass 4 (entity, 5 000-char chunks):
//    Input  = system prompt (~1 320 chars incl. docType+overview) +
//             user prefix (~70 chars) + chunk (5 000 chars)
//           = ~6 390 chars / 3.5 chars·token⁻¹ = ~1 826 tokens
//    Output = max_completion_tokens 8 192; typical 20 entities × ~80 tok = ~1 600;
//             dense doc (35 entities) = ~2 800; sparse (8 entities) = ~640
//
//  Pass 5 (relationship, 4 000-char chunks):
//    Input  = system base (~820 chars) + entity list (~20 chars × entity count)
//             + user prefix (~80 chars) + chunk (4 000 chars)
//           ≈ ~2 314 tokens at 160 entities (grows ~6 tok per additional entity)
//    Output = max 8 192; typical 25 rels × ~50 tok = ~1 250; dense = ~2 500
//
//  Pass 1 (structure, 1 call): ~2 400 input + ~600 output
//  Pass 6 (hierarchy, 1 call): ~1 528 input + ~600 output
//
// Reference pricing: gpt-4o public rates ($2.50 / 1M input, $10.00 / 1M output).
// Model "gpt-5.4" is Replit's internal alias — actual billing rate is unknown;
// the table below shows the gpt-4o baseline. Multiply as needed.

const INPUT_PER_TOKEN  = 2.50  / 1_000_000;  // gpt-4o reference
const OUTPUT_PER_TOKEN = 10.00 / 1_000_000;

// Per-call token budgets (from prompt analysis above)
const ENTITY_INPUT_TOKENS    = 1826;
const ENTITY_OUTPUT_LOW      = 640;    // sparse doc
const ENTITY_OUTPUT_TYPICAL  = 1600;   // avg
const ENTITY_OUTPUT_HIGH     = 2800;   // dense doc

const REL_INPUT_BASE_TOKENS  = 1360;   // without entity list
const REL_INPUT_PER_ENTITY   = 6;      // ~20 chars / 3.5 chars·token⁻¹
const REL_OUTPUT_LOW         = 500;
const REL_OUTPUT_TYPICAL     = 1250;
const REL_OUTPUT_HIGH        = 2500;

// Fixed calls (Pass 1 + Pass 6)
const PASS1_COST = (2400 * INPUT_PER_TOKEN) + (600  * OUTPUT_PER_TOKEN);  // ~$0.012
const PASS6_COST = (1528 * INPUT_PER_TOKEN) + (600  * OUTPUT_PER_TOKEN);  // ~$0.010

function pagesToEntityChunks(pages: number) {
  return Math.max(1, Math.ceil(pages / 12)); // 5,000 chars / ~400 chars per page
}
function entityChunksToRelChunks(entityChunks: number) {
  return Math.max(1, Math.ceil(entityChunks * 0.75));
}

interface CostBreakdown {
  entityChunks: number;
  relChunks: number;
  entityInputTokens: number;
  relInputTokens: number;
  entityOutputRange: [number, number];  // [typical, high]
  relOutputRange: [number, number];
  entityCostLow: number;
  entityCostHigh: number;
  relCostLow: number;
  relCostHigh: number;
  fixedCost: number;
  totalLow: number;       // low output density scenario
  totalTypical: number;
  totalHigh: number;      // high output density scenario
}

function computeCost(pages: number): CostBreakdown {
  const entityChunks = pagesToEntityChunks(pages);
  const relChunks = entityChunksToRelChunks(entityChunks);

  // Entity list grows with entity chunk count: ~20 entities/chunk × 6 tokens/entity
  const estimatedEntities = entityChunks * 20;
  const relInputTokens = REL_INPUT_BASE_TOKENS + (estimatedEntities * REL_INPUT_PER_ENTITY);

  const entityCostLow  = entityChunks * ((ENTITY_INPUT_TOKENS * INPUT_PER_TOKEN) + (ENTITY_OUTPUT_LOW     * OUTPUT_PER_TOKEN));
  const entityCostHigh = entityChunks * ((ENTITY_INPUT_TOKENS * INPUT_PER_TOKEN) + (ENTITY_OUTPUT_HIGH    * OUTPUT_PER_TOKEN));
  const entityCostTyp  = entityChunks * ((ENTITY_INPUT_TOKENS * INPUT_PER_TOKEN) + (ENTITY_OUTPUT_TYPICAL * OUTPUT_PER_TOKEN));

  const relCostLow     = relChunks * ((relInputTokens * INPUT_PER_TOKEN) + (REL_OUTPUT_LOW     * OUTPUT_PER_TOKEN));
  const relCostHigh    = relChunks * ((relInputTokens * INPUT_PER_TOKEN) + (REL_OUTPUT_HIGH    * OUTPUT_PER_TOKEN));
  const relCostTyp     = relChunks * ((relInputTokens * INPUT_PER_TOKEN) + (REL_OUTPUT_TYPICAL * OUTPUT_PER_TOKEN));

  const fixedCost = PASS1_COST + PASS6_COST;

  return {
    entityChunks,
    relChunks,
    entityInputTokens: ENTITY_INPUT_TOKENS,
    relInputTokens,
    entityOutputRange: [ENTITY_OUTPUT_TYPICAL, ENTITY_OUTPUT_HIGH],
    relOutputRange:    [REL_OUTPUT_TYPICAL,    REL_OUTPUT_HIGH],
    entityCostLow,
    entityCostHigh,
    relCostLow,
    relCostHigh,
    fixedCost,
    totalLow:     entityCostLow  + relCostLow  + fixedCost,
    totalTypical: entityCostTyp  + relCostTyp  + fixedCost,
    totalHigh:    entityCostHigh + relCostHigh + fixedCost,
  };
}

// ─── Recommendation engine ─────────────────────────────────────────────────────
interface Recommendation {
  pages: number;
  label: string;
  rationale: string;
  confidence: "high" | "medium";
}

function getRecommendation(
  documentType: string | null | undefined,
  totalPages: number
): Recommendation {
  const type = documentType?.toLowerCase() ?? "other";

  // Coverage ratios — how much of a doc of this type typically needs scanning
  // before entity uniqueness plateaus
  const coverageByType: Record<string, { ratio: number; cap: number; label: string }> = {
    maintenance_manual:       { ratio: 0.35, cap: 400, label: "Maintenance Manual" },
    service_manual:           { ratio: 0.35, cap: 400, label: "Service Manual" },
    installation_manual:      { ratio: 0.45, cap: 350, label: "Installation Manual" },
    operation_manual:         { ratio: 0.30, cap: 300, label: "Operation Manual" },
    system_manual:            { ratio: 0.30, cap: 350, label: "System Manual" },
    technical_specification:  { ratio: 0.25, cap: 250, label: "Technical Specification" },
    parts_catalog:            { ratio: 0.20, cap: 200, label: "Parts Catalog" },
    user_guide:               { ratio: 0.20, cap: 150, label: "User Guide" },
  };

  const cfg = coverageByType[type];

  if (totalPages <= 80) {
    return {
      pages: totalPages,
      label: "Full document",
      rationale: "Short document — covering all pages gives the most complete graph at low cost.",
      confidence: "high",
    };
  }

  if (!cfg) {
    const pages = Math.min(Math.round(totalPages * 0.25 / 10) * 10, 250);
    return {
      pages,
      label: "Starter scan",
      rationale: `Unknown document type — starting with ${pages} pages. You can always re-run with more pages to expand coverage.`,
      confidence: "medium",
    };
  }

  const raw = Math.round((totalPages * cfg.ratio) / 10) * 10;
  const pages = Math.min(raw, cfg.cap, totalPages);

  let rationale: string;
  if (totalPages > 500) {
    rationale = `Large ${cfg.label} (${totalPages} pages). Entity types tend to plateau after ~${pages} pages — start here to validate quality, then expand if you need deeper component coverage.`;
  } else {
    rationale = `${cfg.label} — ${Math.round(cfg.ratio * 100)}% coverage (~${pages} pages) typically captures 75–85% of unique entities. Efficient balance of cost and completeness.`;
  }

  return { pages, label: `Recommended (${pages} pages)`, rationale, confidence: "high" };
}

export default function ManualGraphPage() {
  const { id } = useParams<{ id: string }>();
  const manualId = parseInt(id, 10);
  const queryClient = useQueryClient();

  const [pollInterval, setPollInterval] = useState<number | undefined>(undefined);
  const [pagesToCover, setPagesToCover] = useState<number>(100);
  const [isTriggering, setIsTriggering] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const { data: manual, isLoading: isLoadingManual } = useGetManual(manualId, {
    query: {
      enabled: !!manualId,
      queryKey: getGetManualQueryKey(manualId),
      refetchInterval: pollInterval,
    }
  });

  useEffect(() => {
    if (manual?.status === "processing") {
      setPollInterval(3000);
      setConfirmed(false);
    } else {
      setPollInterval(undefined);
    }
  }, [manual?.status]);

  // Set slider default once we know total pages
  useEffect(() => {
    if (manual?.totalPages && manual.status === "structure_complete") {
      const rec = getRecommendation(manual.documentType, manual.totalPages);
      setPagesToCover(rec.pages);
    }
  }, [manual?.totalPages, manual?.status]);

  const { data: graphData, isLoading: isLoadingGraph } = useGetManualGraph(manualId, {
    query: {
      queryKey: getGetManualGraphQueryKey(manualId),
      enabled: !!manualId && manual?.status === "completed",
    }
  });

  const { data: stats } = useGetManualStats(manualId, {
    query: {
      queryKey: getGetManualStatsQueryKey(manualId),
      enabled: !!manualId && manual?.status === "completed",
    }
  });

  const totalPages = manual?.totalPages ?? 0;
  const clampedPages = Math.min(pagesToCover, totalPages || pagesToCover);
  const cost = computeCost(clampedPages);
  const rec = totalPages > 0 ? getRecommendation(manual?.documentType, totalPages) : null;

  async function handleExtractEntities() {
    setIsTriggering(true);
    setExtractError("");
    try {
      const res = await fetch(`/api/manuals/${manualId}/extract-graph`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityChunks: cost.entityChunks, relChunks: cost.relChunks }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setPollInterval(3000);
      queryClient.invalidateQueries({ queryKey: getGetManualQueryKey(manualId) });
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : "Failed to start extraction");
      setConfirmed(false);
    } finally {
      setIsTriggering(false);
    }
  }

  if (isLoadingManual) {
    return (
      <div className="h-full flex flex-col space-y-4">
        <Skeleton className="h-12 w-1/3" />
        <Skeleton className="flex-1 w-full rounded-lg" />
      </div>
    );
  }

  if (!manual) return <div>Manual not found</div>;

  return (
    <div className="h-full flex flex-col space-y-4 relative">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 shrink-0">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold font-mono tracking-tight text-foreground truncate max-w-xl">
              {manual.name}
            </h1>
            <Badge
              variant={manual.status === "completed" ? "default" : manual.status === "failed" ? "destructive" : "secondary"}
              className="font-mono text-xs uppercase"
            >
              {manual.status === "processing"         && <Clock className="w-3 h-3 mr-1 animate-spin" />}
              {manual.status === "failed"             && <AlertTriangle className="w-3 h-3 mr-1" />}
              {manual.status === "completed"          && <CheckCircle2 className="w-3 h-3 mr-1" />}
              {manual.status === "structure_complete" && <Layers className="w-3 h-3 mr-1" />}
              {manual.status === "structure_complete" ? "Ready for extraction" : manual.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground font-mono flex items-center gap-2 flex-wrap">
            <FileText className="w-4 h-4" /> {manual.filename}
            {totalPages > 0 && <span className="text-muted-foreground/60">· {totalPages.toLocaleString()} pages</span>}
            {manual.documentType && <span className="text-muted-foreground/60">· {manual.documentType.replace(/_/g, " ")}</span>}
          </p>
        </div>

        {stats && (
          <div className="flex items-center gap-4 bg-card border border-border p-2 rounded-md font-mono text-xs shadow-sm">
            <div className="flex items-center gap-2 px-2">
              <Database className="w-4 h-4 text-primary" />
              <div>
                <div className="text-muted-foreground">Entities</div>
                <div className="font-bold text-foreground text-sm">{stats.totalEntities}</div>
              </div>
            </div>
            <div className="w-px h-8 bg-border" />
            <div className="flex items-center gap-2 px-2">
              <Network className="w-4 h-4 text-primary" />
              <div>
                <div className="text-muted-foreground">Relations</div>
                <div className="font-bold text-foreground text-sm">{stats.totalRelationships}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-[400px]">

        {/* ── Processing ── */}
        {manual.status === "processing" && (
          <Card className="h-full flex items-center justify-center bg-card/50 border-dashed">
            <CardContent className="flex flex-col items-center justify-center p-12 max-w-md w-full text-center space-y-6">
              <Clock className="w-12 h-12 text-primary animate-pulse" />
              <div className="w-full">
                <h3 className="text-lg font-medium text-foreground mb-1">Processing Manual</h3>
                <p className="text-sm text-muted-foreground font-mono mb-4">
                  Pass {manual.processingPass || 1} of 7
                </p>
                <Progress value={((manual.processingPass || 1) / 7) * 100} className="h-2 w-full mb-2" />
                <div className="text-xs text-muted-foreground font-mono text-left opacity-70">
                  {manual.processingPass === 1 && "Extracting document structure..."}
                  {manual.processingPass === 2 && "Parsing page content & text..."}
                  {manual.processingPass === 3 && "Analysing images and tables..."}
                  {manual.processingPass === 4 && "Extracting engineering entities..."}
                  {manual.processingPass === 5 && "Mapping component relationships..."}
                  {manual.processingPass === 6 && "Finalising hierarchy..."}
                  {manual.processingPass === 7 && "Indexing text for search (RAG)..."}
                  {!manual.processingPass && "Initialising..."}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Structure complete — choose extraction depth ── */}
        {manual.status === "structure_complete" && rec && (
          <div className="h-full overflow-y-auto">
            <div className="max-w-2xl mx-auto py-6 px-2 space-y-5">

              {/* Recommendation banner */}
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
                <div className="flex items-start gap-3">
                  <Lightbulb className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-amber-900 text-sm mb-1">Recommendation</p>
                    <p className="text-amber-800 text-sm leading-relaxed">{rec.rationale}</p>
                    {clampedPages !== rec.pages && (
                      <button
                        onClick={() => { setPagesToCover(rec.pages); setConfirmed(false); }}
                        className="mt-2 text-xs font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900"
                      >
                        Reset to recommended ({rec.pages.toLocaleString()} pages)
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Slider */}
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="font-semibold text-foreground text-sm">Pages to cover for entity extraction</h3>
                  <span className="font-mono text-sm font-bold text-primary">
                    {clampedPages.toLocaleString()} / {totalPages.toLocaleString()}
                  </span>
                </div>

                <input
                  type="range"
                  min={Math.min(30, totalPages)}
                  max={totalPages}
                  step={10}
                  value={clampedPages}
                  onChange={(e) => { setPagesToCover(Number(e.target.value)); setConfirmed(false); }}
                  className="w-full accent-slate-700"
                />

                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>30 pages · quick</span>
                  <button
                    onClick={() => { setPagesToCover(rec.pages); setConfirmed(false); }}
                    className="text-amber-600 font-medium hover:text-amber-800 underline underline-offset-2"
                  >
                    ★ recommended: {rec.pages.toLocaleString()}
                  </button>
                  <span>full: {totalPages.toLocaleString()}</span>
                </div>
              </div>

              {/* Cost breakdown */}
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-muted-foreground" />
                    <h3 className="font-semibold text-foreground text-sm">Cost estimate</h3>
                  </div>
                  <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">gpt-4o reference rates</span>
                </div>

                {/* Per-call token breakdown */}
                <div className="rounded-lg border border-border overflow-hidden text-xs font-mono">
                  <div className="grid grid-cols-4 bg-muted/60 px-3 py-1.5 text-muted-foreground font-semibold">
                    <span>Call type</span>
                    <span className="text-right">Input tok</span>
                    <span className="text-right">Output tok</span>
                    <span className="text-right">$/call range</span>
                  </div>
                  <div className="divide-y divide-border">
                    <div className="grid grid-cols-4 px-3 py-2 bg-background">
                      <span className="text-muted-foreground">Entity (×{cost.entityChunks})</span>
                      <span className="text-right">{cost.entityInputTokens.toLocaleString()}</span>
                      <span className="text-right">{ENTITY_OUTPUT_LOW}–{ENTITY_OUTPUT_HIGH.toLocaleString()}</span>
                      <span className="text-right">
                        ${(cost.entityCostLow / cost.entityChunks).toFixed(3)}–${(cost.entityCostHigh / cost.entityChunks).toFixed(3)}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 px-3 py-2 bg-background">
                      <span className="text-muted-foreground">Relation (×{cost.relChunks})</span>
                      <span className="text-right">{cost.relInputTokens.toLocaleString()}</span>
                      <span className="text-right">{REL_OUTPUT_LOW}–{REL_OUTPUT_HIGH.toLocaleString()}</span>
                      <span className="text-right">
                        ${(cost.relCostLow / cost.relChunks).toFixed(3)}–${(cost.relCostHigh / cost.relChunks).toFixed(3)}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 px-3 py-2 bg-background">
                      <span className="text-muted-foreground">Fixed (×2)</span>
                      <span className="text-right">~1,960</span>
                      <span className="text-right">~600</span>
                      <span className="text-right text-muted-foreground">${(cost.fixedCost / 2).toFixed(3)}</span>
                    </div>
                  </div>
                </div>

                {/* Total row */}
                <div className="flex items-end justify-between border-t border-border pt-3">
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">
                      {cost.entityChunks + cost.relChunks + 2} total AI calls
                      · {((cost.entityChunks * cost.entityInputTokens) + (cost.relChunks * cost.relInputTokens) + 3960).toLocaleString()} input tokens
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Output varies by document density (range = sparse → dense content)
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground mb-0.5">Sparse → Dense</div>
                    <div className="font-mono font-bold text-foreground text-lg">
                      ${cost.totalLow.toFixed(2)} – ${cost.totalHigh.toFixed(2)}
                    </div>
                    <div className="text-xs text-muted-foreground">typical: ~${cost.totalTypical.toFixed(2)}</div>
                  </div>
                </div>

                {/* Model pricing disclaimer */}
                <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2 border border-border">
                  <span className="shrink-0 font-semibold text-foreground/60">⚠</span>
                  <span>
                    Model <code className="bg-muted px-1 rounded">gpt-5.4</code> is Replit's internal alias — actual per-token billing may differ from these gpt-4o reference rates.
                    Token counts are exact (computed from real prompt sizes); only the dollar rate is uncertain.
                  </span>
                </div>
              </div>

              {/* Confirm + Extract */}
              {extractError && (
                <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  {extractError}
                </div>
              )}

              {!confirmed ? (
                <button
                  onClick={() => setConfirmed(true)}
                  className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold text-sm transition-all active:scale-[0.98] shadow"
                >
                  <Zap className="w-4 h-4" />
                  Review &amp; Confirm ({clampedPages.toLocaleString()} pages · ~${cost.totalTypical.toFixed(2)} typical)
                </button>
              ) : (
                <div className="rounded-xl border-2 border-slate-800 bg-slate-50 p-5 space-y-3">
                  <p className="text-sm font-semibold text-slate-800">Confirm extraction settings</p>
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                    <div className="bg-white border border-border rounded-lg p-3">
                      <div className="text-muted-foreground">Pages covered</div>
                      <div className="font-bold text-foreground text-base">{clampedPages.toLocaleString()}</div>
                    </div>
                    <div className="bg-white border border-border rounded-lg p-3">
                      <div className="text-muted-foreground">Total AI calls</div>
                      <div className="font-bold text-foreground text-base">{cost.entityChunks + cost.relChunks + 2}</div>
                    </div>
                    <div className="bg-white border border-border rounded-lg p-3">
                      <div className="text-muted-foreground">Est. cost (low)</div>
                      <div className="font-bold text-green-700 text-base">${cost.totalLow.toFixed(2)}</div>
                    </div>
                    <div className="bg-white border border-border rounded-lg p-3">
                      <div className="text-muted-foreground">Est. cost (high)</div>
                      <div className="font-bold text-orange-600 text-base">${cost.totalHigh.toFixed(2)}</div>
                    </div>
                  </div>
                  <div className="flex gap-3 pt-1">
                    <button
                      onClick={() => setConfirmed(false)}
                      className="flex-1 py-2.5 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:bg-muted transition-colors"
                    >
                      Back
                    </button>
                    <button
                      onClick={handleExtractEntities}
                      disabled={isTriggering}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white font-semibold text-sm transition-all active:scale-[0.98]"
                    >
                      <Play className="w-4 h-4" />
                      {isTriggering ? "Starting…" : "Start Extraction"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Failed ── */}
        {manual.status === "failed" && (
          <Card className="h-full flex items-center justify-center bg-destructive/5 border-destructive/20 border-dashed">
            <CardContent className="flex flex-col items-center justify-center p-12 text-center max-w-md">
              <AlertTriangle className="w-12 h-12 text-destructive mb-4" />
              <h3 className="text-lg font-medium text-destructive mb-2">Processing Failed</h3>
              <p className="text-sm text-muted-foreground font-mono">
                {manual.errorMessage || "An unknown error occurred during extraction."}
              </p>
            </CardContent>
          </Card>
        )}

        {/* ── Graph loading ── */}
        {manual.status === "completed" && isLoadingGraph && (
          <div className="h-full flex items-center justify-center border border-border rounded-lg bg-card/20">
            <div className="flex flex-col items-center gap-4">
              <Clock className="w-8 h-8 text-primary animate-spin" />
              <span className="font-mono text-sm text-muted-foreground">Loading graph layout...</span>
            </div>
          </div>
        )}

        {/* ── Graph ── */}
        {manual.status === "completed" && graphData && (
          <GraphView data={graphData} />
        )}
      </div>
    </div>
  );
}
