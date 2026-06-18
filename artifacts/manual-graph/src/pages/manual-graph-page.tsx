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
  Layers, Play, ChevronDown, ChevronUp,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

// ─── Token-based cost model ────────────────────────────────────────────────────
// Computed from actual prompt character counts in extractionPipeline.ts.
// Reference pricing: gpt-4o public rates ($2.50/1M input, $10/1M output).
// gpt-5.4 is Replit's internal alias — token counts are exact, dollar rate is reference-only.

const INPUT_PER_TOKEN  = 2.50  / 1_000_000;
const OUTPUT_PER_TOKEN = 10.00 / 1_000_000;

const ENTITY_INPUT_TOKENS   = 1826;
const ENTITY_OUTPUT_TYPICAL = 1600;
const ENTITY_OUTPUT_HIGH    = 2800;

const REL_INPUT_BASE    = 1360;
const REL_INPUT_PER_ENT = 6;       // ~20 chars per entity name / 3.5 chars·tok⁻¹
const REL_OUTPUT_TYPICAL = 1250;
const REL_OUTPUT_HIGH    = 2500;

const FIXED_COST = ((2400 + 1528) * INPUT_PER_TOKEN) + ((600 + 600) * OUTPUT_PER_TOKEN);

function pagesToEntityChunks(pages: number) {
  return Math.max(1, Math.ceil(pages / 12));
}
function entityChunksToRelChunks(ec: number) {
  return Math.max(1, Math.ceil(ec * 0.75));
}

interface Cost { low: number; typical: number; high: number; entityChunks: number; relChunks: number; relInputTokens: number; }

function computeCost(pages: number): Cost {
  const ec = pagesToEntityChunks(pages);
  const rc = entityChunksToRelChunks(ec);
  const estEntities = ec * 20;
  const relIn = REL_INPUT_BASE + estEntities * REL_INPUT_PER_ENT;

  const eTyp  = ec * ((ENTITY_INPUT_TOKENS * INPUT_PER_TOKEN) + (ENTITY_OUTPUT_TYPICAL * OUTPUT_PER_TOKEN));
  const eHigh = ec * ((ENTITY_INPUT_TOKENS * INPUT_PER_TOKEN) + (ENTITY_OUTPUT_HIGH    * OUTPUT_PER_TOKEN));
  const rTyp  = rc * ((relIn * INPUT_PER_TOKEN) + (REL_OUTPUT_TYPICAL * OUTPUT_PER_TOKEN));
  const rHigh = rc * ((relIn * INPUT_PER_TOKEN) + (REL_OUTPUT_HIGH    * OUTPUT_PER_TOKEN));

  return {
    low: eTyp * 0.4 + rTyp * 0.4 + FIXED_COST,
    typical: eTyp + rTyp + FIXED_COST,
    high: eHigh + rHigh + FIXED_COST,
    entityChunks: ec,
    relChunks: rc,
    relInputTokens: relIn,
  };
}

// ─── Recommendation engine ─────────────────────────────────────────────────────
interface TierPages { quick: number; recommended: number; full: number }

function computeTierPages(documentType: string | null | undefined, totalPages: number): TierPages {
  const type = documentType?.toLowerCase() ?? "other";
  const coverageByType: Record<string, { ratio: number; cap: number }> = {
    maintenance_manual:      { ratio: 0.35, cap: 400 },
    service_manual:          { ratio: 0.35, cap: 400 },
    installation_manual:     { ratio: 0.45, cap: 350 },
    operation_manual:        { ratio: 0.30, cap: 300 },
    system_manual:           { ratio: 0.30, cap: 350 },
    technical_specification: { ratio: 0.25, cap: 250 },
    parts_catalog:           { ratio: 0.20, cap: 200 },
    user_guide:              { ratio: 0.20, cap: 150 },
  };

  const cfg = coverageByType[type] ?? { ratio: 0.25, cap: 250 };

  if (totalPages <= 80) {
    return { quick: totalPages, recommended: totalPages, full: totalPages };
  }

  const quick = Math.min(Math.max(30, Math.round(totalPages * 0.10 / 10) * 10), 80);
  const recRaw = Math.round((totalPages * cfg.ratio) / 10) * 10;
  const recommended = Math.min(recRaw, cfg.cap, totalPages);
  const full = totalPages;

  return { quick, recommended, full };
}

type TierId = "quick" | "recommended" | "full";

interface TierConfig {
  id: TierId;
  label: string;
  emoji: string;
  tagline: string;
  outcomes: string[];
  cautionNote?: string;
}

const TIER_CONFIG: TierConfig[] = [
  {
    id: "quick",
    label: "Quick Scan",
    emoji: "⚡",
    tagline: "First chapter only",
    outcomes: [
      "Top-level machines and main systems",
      "Primary connections between systems",
      "Good for a first look or simple documents",
    ],
  },
  {
    id: "recommended",
    label: "Recommended",
    emoji: "★",
    tagline: "Smart coverage for this document",
    outcomes: [
      "All major components and subsystems",
      "Most processes and their relationships",
      "Best balance of cost and completeness",
    ],
  },
  {
    id: "full",
    label: "Full Analysis",
    emoji: "🔬",
    tagline: "Every page, every entity",
    outcomes: [
      "Complete part and sensor inventory",
      "All procedures and their sequences",
      "Maximum detail — takes longer and costs more",
    ],
    cautionNote: "High cost for large documents",
  },
];

export default function ManualGraphPage() {
  const { id } = useParams<{ id: string }>();
  const manualId = parseInt(id, 10);
  const queryClient = useQueryClient();

  const [pollInterval, setPollInterval] = useState<number | undefined>(undefined);
  const [selectedTier, setSelectedTier] = useState<TierId>("recommended");
  const [customPages, setCustomPages] = useState<number>(100);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [extractError, setExtractError] = useState("");

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
    } else {
      setPollInterval(undefined);
    }
  }, [manual?.status]);

  useEffect(() => {
    if (manual?.totalPages) {
      setCustomPages(Math.min(150, manual.totalPages));
    }
  }, [manual?.totalPages]);

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
  const tierPages = computeTierPages(manual?.documentType, totalPages);

  // Pages to use based on selection
  const pagesForTier: Record<TierId, number> = {
    quick: tierPages.quick,
    recommended: tierPages.recommended,
    full: tierPages.full,
  };
  const activeTier = showAdvanced ? "recommended" : selectedTier;
  const pages = showAdvanced ? Math.min(customPages, totalPages) : pagesForTier[selectedTier];
  const cost = computeCost(pages);

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
      {/* ── Header ── */}
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

        {/* ── Structure complete — tier picker ── */}
        {manual.status === "structure_complete" && (
          <div className="h-full overflow-y-auto">
            <div className="max-w-2xl mx-auto py-6 px-2 space-y-5">

              {/* Intro */}
              <div>
                <h2 className="text-base font-semibold text-foreground mb-1">
                  Document indexed — now extract the knowledge graph
                </h2>
                <p className="text-sm text-muted-foreground">
                  Search and chat are already working. Choose how deeply to analyse this document for the interactive graph.
                </p>
              </div>

              {/* Tier cards */}
              {!showAdvanced && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {TIER_CONFIG.map((tier) => {
                    const tPages = pagesForTier[tier.id];
                    const tCost = computeCost(tPages);
                    const isSelected = selectedTier === tier.id;
                    const isRec = tier.id === "recommended";

                    return (
                      <button
                        key={tier.id}
                        onClick={() => setSelectedTier(tier.id)}
                        className={[
                          "relative text-left rounded-xl border-2 p-4 transition-all",
                          isSelected
                            ? "border-slate-800 bg-slate-800 text-white shadow-lg"
                            : "border-border bg-card hover:border-slate-400 text-foreground",
                        ].join(" ")}
                      >
                        {isRec && (
                          <span className={[
                            "absolute -top-2.5 left-3 text-xs font-bold px-2 py-0.5 rounded-full",
                            isSelected ? "bg-amber-400 text-amber-900" : "bg-amber-100 text-amber-700 border border-amber-200",
                          ].join(" ")}>
                            ★ Recommended
                          </span>
                        )}

                        <div className="text-2xl mb-2">{tier.emoji}</div>
                        <div className="font-semibold text-sm mb-0.5">{tier.label}</div>
                        <div className={["text-xs mb-3", isSelected ? "text-white/70" : "text-muted-foreground"].join(" ")}>
                          {tier.tagline}
                        </div>

                        <ul className="space-y-1 mb-4">
                          {tier.outcomes.map((o, i) => (
                            <li key={i} className={["text-xs flex items-start gap-1.5", isSelected ? "text-white/80" : "text-muted-foreground"].join(" ")}>
                              <span className="mt-0.5 shrink-0">·</span>
                              <span>{o}</span>
                            </li>
                          ))}
                        </ul>

                        {tier.cautionNote && !isSelected && (
                          <div className="text-xs text-orange-600 mb-2">⚠ {tier.cautionNote}</div>
                        )}

                        <div className={["text-xs font-mono border-t pt-2", isSelected ? "border-white/20" : "border-border"].join(" ")}>
                          <div className={isSelected ? "text-white/60" : "text-muted-foreground"}>
                            ~{tPages.toLocaleString()} pages
                          </div>
                          <div className={["font-bold text-sm", isSelected ? "text-white" : "text-foreground"].join(" ")}>
                            ~${tCost.typical.toFixed(2)}
                            <span className={["font-normal text-xs ml-1", isSelected ? "text-white/50" : "text-muted-foreground"].join(" ")}>
                              (${tCost.low.toFixed(2)}–${tCost.high.toFixed(2)})
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Advanced / custom pages */}
              <div>
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  {showAdvanced ? "Hide advanced settings" : "Advanced: set exact page count"}
                </button>

                {showAdvanced && (
                  <div className="mt-3 rounded-xl border border-border bg-card p-5 space-y-4">
                    <div className="flex justify-between items-center">
                      <label className="text-sm font-medium text-foreground">Pages to cover</label>
                      <span className="font-mono text-sm font-bold text-primary">
                        {Math.min(customPages, totalPages).toLocaleString()} / {totalPages.toLocaleString()}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={Math.min(30, totalPages)}
                      max={totalPages || 1}
                      step={10}
                      value={Math.min(customPages, totalPages)}
                      onChange={(e) => setCustomPages(Number(e.target.value))}
                      className="w-full accent-slate-700"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>30 pages</span>
                      <button
                        onClick={() => setCustomPages(tierPages.recommended)}
                        className="text-amber-600 underline underline-offset-2 hover:text-amber-800"
                      >
                        ★ recommended: {tierPages.recommended}
                      </button>
                      <span>{totalPages.toLocaleString()} pages</span>
                    </div>

                    {/* Token breakdown table */}
                    <div className="rounded-lg border border-border overflow-hidden text-xs font-mono mt-2">
                      <div className="grid grid-cols-4 bg-muted/60 px-3 py-1.5 text-muted-foreground font-semibold">
                        <span>Call type</span>
                        <span className="text-right">Input tok</span>
                        <span className="text-right">Output tok</span>
                        <span className="text-right">$/call</span>
                      </div>
                      <div className="divide-y divide-border">
                        <div className="grid grid-cols-4 px-3 py-2 bg-background">
                          <span className="text-muted-foreground">Entity (×{cost.entityChunks})</span>
                          <span className="text-right">{ENTITY_INPUT_TOKENS.toLocaleString()}</span>
                          <span className="text-right">{ENTITY_OUTPUT_TYPICAL}–{ENTITY_OUTPUT_HIGH}</span>
                          <span className="text-right">$0.017–$0.033</span>
                        </div>
                        <div className="grid grid-cols-4 px-3 py-2 bg-background">
                          <span className="text-muted-foreground">Relation (×{cost.relChunks})</span>
                          <span className="text-right">{cost.relInputTokens.toLocaleString()}</span>
                          <span className="text-right">{REL_OUTPUT_TYPICAL}–{REL_OUTPUT_HIGH}</span>
                          <span className="text-right">$0.013–$0.026</span>
                        </div>
                        <div className="grid grid-cols-4 px-3 py-2 bg-background">
                          <span className="text-muted-foreground">Fixed (×2)</span>
                          <span className="text-right">~1,960</span>
                          <span className="text-right">~600</span>
                          <span className="text-right text-muted-foreground">$0.011</span>
                        </div>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Token counts computed from actual prompt sizes. Dollar rates use gpt-4o as reference —{" "}
                      <code className="bg-muted px-1 rounded">gpt-5.4</code> (Replit's model alias) may differ.
                    </p>
                  </div>
                )}
              </div>

              {/* Cost summary + CTA */}
              <div className="rounded-xl border-2 border-slate-200 bg-slate-50 p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      {showAdvanced
                        ? `Custom · ${Math.min(customPages, totalPages).toLocaleString()} pages`
                        : `${TIER_CONFIG.find(t => t.id === selectedTier)?.label} · ${pagesForTier[selectedTier].toLocaleString()} pages`}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {cost.entityChunks + cost.relChunks + 2} AI calls · ~{cost.entityChunks * 20} entities expected
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">Estimated cost</div>
                    <div className="text-xl font-bold font-mono text-foreground">
                      ~${cost.typical.toFixed(2)}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      ${cost.low.toFixed(2)} – ${cost.high.toFixed(2)}
                    </div>
                  </div>
                </div>

                {extractError && (
                  <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    {extractError}
                  </div>
                )}

                <button
                  onClick={handleExtractEntities}
                  disabled={isTriggering}
                  className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white font-semibold text-sm transition-all active:scale-[0.98] shadow"
                >
                  <Play className="w-4 h-4" />
                  {isTriggering ? "Starting…" : "Extract Knowledge Graph"}
                </button>
              </div>

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
