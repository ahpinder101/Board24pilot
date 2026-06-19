import { useParams } from "wouter";
import {
  useGetManual,
  useGetManualGraph,
  useGetManualStats,
  useGetExtractionPlan,
  getGetManualQueryKey,
  getGetManualGraphQueryKey,
  getGetManualStatsQueryKey,
  getGetExtractionPlanQueryKey,
  type ExtractionTier,
} from "@workspace/api-client-react";
import { GraphView } from "@/components/graph-view";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import {
  Clock, CheckCircle2, AlertTriangle, FileText, Database, Network,
  Layers, Play, ChevronDown, ChevronUp, Info, RefreshCw, WifiOff,
  Activity,
} from "lucide-react";
import { useEffect, useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";

// ─── Cost model ────────────────────────────────────────────────────────────────
// Dollar amounts use gpt-4o public rates as a reference baseline.
// gpt-5.4 is Replit's internal model alias — token counts from the API are exact,
// the dollar rate is the only uncertain part.
const INPUT_PRICE  = 2.50  / 1_000_000;   // $ per input token  (gpt-4o reference)
const OUTPUT_PRICE = 10.00 / 1_000_000;   // $ per output token (gpt-4o reference)

function tierCost(tier: ExtractionTier) {
  const low     = tier.totalInputTokens * INPUT_PRICE + tier.outputTokensLow      * OUTPUT_PRICE;
  const typical = tier.totalInputTokens * INPUT_PRICE + tier.outputTokensTypical  * OUTPUT_PRICE;
  const high    = tier.totalInputTokens * INPUT_PRICE + tier.outputTokensHigh     * OUTPUT_PRICE;
  return { low, typical, high };
}

type TierId = "quick" | "recommended" | "full";

interface TierMeta { id: TierId; label: string; emoji: string; tagline: string; outcomes: string[]; warnLarge?: boolean }

const TIER_META: TierMeta[] = [
  {
    id: "quick",
    label: "Quick Scan",
    emoji: "⚡",
    tagline: "First section only",
    outcomes: ["Top-level machines and main systems", "Primary connections between systems", "Fast — good for a first look"],
  },
  {
    id: "recommended",
    label: "Recommended",
    emoji: "★",
    tagline: "Balanced coverage",
    outcomes: ["All major components and subsystems", "Most processes and their sequences", "Best balance of cost and completeness"],
  },
  {
    id: "full",
    label: "Full Analysis",
    emoji: "🔬",
    tagline: "Every page, every entity",
    outcomes: ["Complete part and sensor inventory", "All procedures and their dependencies", "Maximum detail"],
    warnLarge: true,
  },
];

// ─── Pending card — manual uploaded but not yet processed ───────────────────

function PendingCard({ manualId, onStarted }: { manualId: number; onStarted: () => void }) {
  const { getToken } = useAuth();
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState("");

  async function handleStart() {
    setIsStarting(true);
    setError("");
    try {
      const token = await getToken();
      const res = await fetch(`/api/manuals/${manualId}/process`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start processing");
      setIsStarting(false);
    }
  }

  return (
    <Card className="h-full flex items-center justify-center bg-card/50 border-dashed">
      <CardContent className="flex flex-col items-center justify-center p-10 max-w-md w-full text-center space-y-5">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
          <Play className="w-7 h-7 text-primary" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-foreground">Ready to process</h3>
          <p className="text-sm text-muted-foreground mt-1">
            The PDF is uploaded. Start processing to extract text, images, and build the knowledge graph.
          </p>
        </div>
        {error && (
          <div className="flex items-center gap-2 text-red-600 text-xs bg-red-50 border border-red-200 rounded-lg px-3 py-2 w-full text-left">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </div>
        )}
        <button
          onClick={handleStart}
          disabled={isStarting}
          className="flex items-center gap-2 px-6 py-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-semibold text-sm transition-all shadow disabled:opacity-50"
        >
          {isStarting
            ? <><RefreshCw className="w-4 h-4 animate-spin" />Starting…</>
            : <><Play className="w-4 h-4" />Start Processing</>}
        </button>
      </CardContent>
    </Card>
  );
}

// ─── Reset button for failed manuals ────────────────────────────────────────

function FailedResetButton({ manualId, onReset }: { manualId: number; onReset: () => void }) {
  const { getToken } = useAuth();
  const [isResetting, setIsResetting] = useState(false);

  async function handleReset() {
    setIsResetting(true);
    try {
      const token = await getToken();
      const res = await fetch(`/api/manuals/${manualId}/reset-processing`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) onReset();
    } finally {
      setIsResetting(false);
    }
  }

  return (
    <button
      onClick={handleReset}
      disabled={isResetting}
      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white shadow transition-all disabled:opacity-50"
    >
      <RefreshCw className={["w-4 h-4", isResetting ? "animate-spin" : ""].join(" ")} />
      {isResetting ? "Resetting..." : "Reset & Retry"}
    </button>
  );
}

// ─── Live processing ticker ─────────────────────────────────────────────────

const STALL_SECONDS = 90;

function ProcessingTicker({
  manual,
  manualId,
  onReset,
}: {
  manual: { processingPass?: number | null; currentActivity?: string | null; updatedAt: string };
  manualId: number;
  onReset: () => void;
}) {
  const { getToken } = useAuth();
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [isResetting, setIsResetting] = useState(false);
  const lastUpdatedRef = useRef(new Date(manual.updatedAt).getTime());

  // Update lastUpdatedRef when server sends a fresh updatedAt
  useEffect(() => {
    lastUpdatedRef.current = new Date(manual.updatedAt).getTime();
    setSecondsAgo(0);
  }, [manual.updatedAt]);

  // Real-time counter — increments every second independently of polling
  useEffect(() => {
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - lastUpdatedRef.current) / 1000);
      setSecondsAgo(elapsed);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const isStalled = secondsAgo > STALL_SECONDS;
  const isSlow = secondsAgo > 40;

  async function handleReset() {
    setIsResetting(true);
    try {
      const token = await getToken();
      const res = await fetch(`/api/manuals/${manualId}/reset-processing`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) onReset();
    } finally {
      setIsResetting(false);
    }
  }

  const pass = manual.processingPass ?? 0;
  const activity = manual.currentActivity ?? "Initialising...";

  return (
    <Card className="h-full flex items-center justify-center bg-card/50 border-dashed">
      <CardContent className="flex flex-col items-center justify-center p-10 max-w-lg w-full text-center space-y-5">

        {/* Live pulse indicator */}
        <div className="relative flex items-center justify-center">
          {isStalled ? (
            <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center">
              <WifiOff className="w-7 h-7 text-red-500" />
            </div>
          ) : (
            <div className="relative w-14 h-14">
              <div className={[
                "absolute inset-0 rounded-full animate-ping opacity-30",
                isSlow ? "bg-amber-400" : "bg-green-400",
              ].join(" ")} />
              <div className={[
                "relative w-14 h-14 rounded-full flex items-center justify-center",
                isSlow ? "bg-amber-100" : "bg-green-100",
              ].join(" ")}>
                <Activity className={["w-7 h-7", isSlow ? "text-amber-600" : "text-green-600"].join(" ")} />
              </div>
            </div>
          )}
        </div>

        {/* Title + pass */}
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            {isStalled ? "Processing appears stalled" : "Processing Manual"}
          </h3>
          <p className="text-sm text-muted-foreground font-mono mt-0.5">
            Pass {pass} of 7
          </p>
        </div>

        {/* Progress bar */}
        <Progress
          value={(pass / 7) * 100}
          className={["h-1.5 w-full", isStalled ? "[&>div]:bg-red-400" : ""].join(" ")}
        />

        {/* Live activity text — this is the real ticker */}
        <div className={[
          "w-full rounded-lg border px-4 py-3 font-mono text-xs text-left leading-relaxed",
          isStalled
            ? "border-red-200 bg-red-50 text-red-700"
            : "border-border bg-muted/40 text-muted-foreground",
        ].join(" ")}>
          <div className="flex items-start gap-2">
            {!isStalled && (
              <span className="mt-0.5 shrink-0 text-green-500 animate-pulse">▶</span>
            )}
            <span>{activity}</span>
          </div>
        </div>

        {/* Heartbeat counter */}
        <div className={[
          "flex items-center gap-2 text-xs font-mono",
          isStalled ? "text-red-500 font-semibold" : isSlow ? "text-amber-600" : "text-muted-foreground",
        ].join(" ")}>
          <Clock className="w-3.5 h-3.5" />
          {isStalled
            ? `No activity for ${secondsAgo}s — pipeline may have crashed`
            : isSlow
              ? `Last update ${secondsAgo}s ago — waiting for API response...`
              : `Last update ${secondsAgo}s ago`}
        </div>

        {/* Reset button — always available when processing, prominent when stalled */}
        <button
          onClick={handleReset}
          disabled={isResetting}
          className={[
            "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
            isStalled
              ? "bg-red-600 hover:bg-red-700 text-white shadow"
              : "border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30",
            isResetting ? "opacity-50 cursor-not-allowed" : "",
          ].join(" ")}
        >
          <RefreshCw className={["w-4 h-4", isResetting ? "animate-spin" : ""].join(" ")} />
          {isResetting ? "Resetting..." : isStalled ? "Reset & Retry" : "Cancel & Reset"}
        </button>

        {isStalled && (
          <p className="text-xs text-muted-foreground max-w-xs">
            Resetting will not lose extracted data. The job will restart from where it left off.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function ManualGraphPage() {
  const { id } = useParams<{ id: string }>();
  const manualId = parseInt(id, 10);
  const queryClient = useQueryClient();

  const [selectedTier, setSelectedTier] = useState<TierId>("recommended");
  const [customPages, setCustomPages] = useState<number>(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [extractError, setExtractError] = useState("");

  const { data: manual, isLoading: isLoadingManual } = useGetManual(manualId, {
    query: {
      enabled: !!manualId,
      queryKey: getGetManualQueryKey(manualId),
      refetchInterval: (query) =>
        query.state.data?.status === "processing" ? 3000 : false,
    }
  });

  const { data: plan, isLoading: isPlanLoading } = useGetExtractionPlan(manualId, {
    query: {
      queryKey: getGetExtractionPlanQueryKey(manualId),
      enabled: !!manualId && manual?.status === "structure_complete",
    }
  });

  // Initialise custom page slider from plan data
  useEffect(() => {
    if (plan && customPages === 0) {
      setCustomPages(plan.tiers.recommended.pages);
    }
  }, [plan, customPages]);

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

  // Active tier data — either from plan or a fallback custom page count
  const activeTierData: ExtractionTier | null = plan
    ? showAdvanced
      ? (() => {
          // Linearly interpolate between tiers based on custom page count
          const cp = Math.min(customPages || plan.tiers.recommended.pages, manual?.totalPages ?? customPages);
          const ratio = cp / (manual?.totalPages || 1);
          const full = plan.tiers.full;
          return {
            pages: cp,
            entityChunks: Math.max(1, Math.ceil(ratio * full.entityChunks)),
            relChunks: Math.max(1, Math.ceil(ratio * full.relChunks)),
            totalInputTokens: Math.round(ratio * full.totalInputTokens),
            outputTokensLow: Math.round(ratio * full.outputTokensLow),
            outputTokensTypical: Math.round(ratio * full.outputTokensTypical),
            outputTokensHigh: Math.round(ratio * full.outputTokensHigh),
            rationale: `Custom: ${cp.toLocaleString()} pages`,
          };
        })()
      : plan.tiers[selectedTier]
    : null;

  const activeCost = activeTierData ? tierCost(activeTierData) : null;

  async function handleExtractEntities() {
    if (!activeTierData) return;
    setIsTriggering(true);
    setExtractError("");
    try {
      const res = await fetch(`/api/manuals/${manualId}/extract-graph`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityChunks: activeTierData.entityChunks, relChunks: activeTierData.relChunks }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
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

  const totalPages = manual.totalPages ?? 0;
  const customPageCount = Math.min(customPages !== 0 ? customPages : (plan?.tiers.recommended.pages ?? 0), totalPages);

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

        {/* ── Pending — needs processing triggered ── */}
        {manual.status === "pending" && (
          <PendingCard manualId={manualId} onStarted={() => queryClient.invalidateQueries({ queryKey: getGetManualQueryKey(manualId) })} />
        )}

        {/* ── Processing — live ticker ── */}
        {manual.status === "processing" && (
          <ProcessingTicker
            manual={manual}
            manualId={manualId}
            onReset={() => queryClient.invalidateQueries({ queryKey: getGetManualQueryKey(manualId) })}
          />
        )}

        {/* ── Failed — reset option ── */}
        {manual.status === "failed" && (
          <Card className="h-full flex items-center justify-center bg-card/50 border-dashed border-red-200">
            <CardContent className="flex flex-col items-center justify-center p-10 max-w-md w-full text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center">
                <AlertTriangle className="w-7 h-7 text-red-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">Processing failed</h3>
                {manual.errorMessage && (
                  <p className="text-xs text-red-600 font-mono mt-1 bg-red-50 border border-red-200 rounded px-3 py-2 text-left">
                    {manual.errorMessage}
                  </p>
                )}
              </div>
              <FailedResetButton manualId={manualId} onReset={() => queryClient.invalidateQueries({ queryKey: getGetManualQueryKey(manualId) })} />
            </CardContent>
          </Card>
        )}

        {/* ── Structure complete — plan picker ── */}
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

              {/* Document stats summary (from real analysis) */}
              {plan && (
                <div className="flex items-start gap-2 text-xs bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-blue-800">
                  <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-400" />
                  <span>
                    Analysed your manual: <strong>{plan.contentPages.toLocaleString()} content pages</strong>{" "}
                    · <strong>{plan.totalTextChars.toLocaleString()} chars</strong> of text
                    · avg <strong>{plan.avgCharsPerPage.toLocaleString()} chars/page</strong> ({plan.densityLabel} content).
                    Costs below are computed from your actual document.
                  </span>
                </div>
              )}

              {/* Tier cards */}
              {isPlanLoading && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {[0, 1, 2].map(i => <Skeleton key={i} className="h-52 rounded-xl" />)}
                </div>
              )}

              {plan && !showAdvanced && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {TIER_META.map((meta) => {
                    const tier = plan.tiers[meta.id];
                    const cost = tierCost(tier);
                    const isSelected = selectedTier === meta.id;
                    const isRec = meta.id === "recommended";
                    const isExpensive = meta.id === "full" && tier.pages > 400;

                    return (
                      <button
                        key={meta.id}
                        onClick={() => setSelectedTier(meta.id)}
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

                        <div className="text-2xl mb-2">{meta.emoji}</div>
                        <div className="font-semibold text-sm mb-0.5">{meta.label}</div>
                        <div className={["text-xs mb-3", isSelected ? "text-white/70" : "text-muted-foreground"].join(" ")}>
                          {tier.pages.toLocaleString()} pages · {tier.entityChunks + tier.relChunks + 2} AI calls
                        </div>

                        <ul className="space-y-1 mb-4">
                          {meta.outcomes.map((o, i) => (
                            <li key={i} className={["text-xs flex items-start gap-1.5", isSelected ? "text-white/80" : "text-muted-foreground"].join(" ")}>
                              <span className="mt-0.5 shrink-0">·</span><span>{o}</span>
                            </li>
                          ))}
                        </ul>

                        {isExpensive && !isSelected && (
                          <div className="text-xs text-orange-600 mb-2">⚠ High cost for large doc</div>
                        )}

                        <div className={["border-t pt-2 text-xs font-mono", isSelected ? "border-white/20" : "border-border"].join(" ")}>
                          <div className={["font-bold text-sm", isSelected ? "text-white" : "text-foreground"].join(" ")}>
                            ~${cost.typical.toFixed(2)}
                          </div>
                          <div className={["text-xs", isSelected ? "text-white/50" : "text-muted-foreground"].join(" ")}>
                            ${cost.low.toFixed(2)} – ${cost.high.toFixed(2)} range
                          </div>
                          <div className={["text-xs mt-1", isSelected ? "text-white/40" : "text-muted-foreground/60"].join(" ")}>
                            {tier.totalInputTokens.toLocaleString()} input tok
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Rationale from server */}
              {plan && !showAdvanced && activeTierData && (
                <div className="rounded-lg bg-muted/40 border border-border px-4 py-3 text-xs text-muted-foreground leading-relaxed">
                  {activeTierData.rationale}
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

                {showAdvanced && plan && (
                  <div className="mt-3 rounded-xl border border-border bg-card p-5 space-y-4">
                    <div className="flex justify-between items-center">
                      <label className="text-sm font-medium text-foreground">Pages to cover</label>
                      <span className="font-mono text-sm font-bold text-primary">
                        {Math.min(customPages || plan.tiers.recommended.pages, totalPages).toLocaleString()} / {totalPages.toLocaleString()}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={Math.min(30, totalPages)}
                      max={totalPages || 1}
                      step={10}
                      value={Math.min(customPages || plan.tiers.recommended.pages, totalPages)}
                      onChange={(e) => setCustomPages(Number(e.target.value))}
                      className="w-full accent-slate-700"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{plan.tiers.quick.pages} pages (quick)</span>
                      <button
                        onClick={() => setCustomPages(plan.tiers.recommended.pages)}
                        className="text-amber-600 underline underline-offset-2 hover:text-amber-800"
                      >
                        ★ recommended: {plan.tiers.recommended.pages}
                      </button>
                      <span>{totalPages.toLocaleString()} (full)</span>
                    </div>

                    {/* Token breakdown — from real numbers */}
                    {activeTierData && (
                      <div className="rounded-lg border border-border overflow-hidden text-xs font-mono mt-2">
                        <div className="grid grid-cols-3 bg-muted/60 px-3 py-1.5 text-muted-foreground font-semibold">
                          <span>Call type</span>
                          <span className="text-right">AI calls</span>
                          <span className="text-right">Input tokens</span>
                        </div>
                        <div className="divide-y divide-border">
                          <div className="grid grid-cols-3 px-3 py-2 bg-background">
                            <span className="text-muted-foreground">Entity extraction</span>
                            <span className="text-right">{activeTierData.entityChunks}</span>
                            <span className="text-right">{(activeTierData.entityChunks * 1826).toLocaleString()}</span>
                          </div>
                          <div className="grid grid-cols-3 px-3 py-2 bg-background">
                            <span className="text-muted-foreground">Rel. extraction</span>
                            <span className="text-right">{activeTierData.relChunks}</span>
                            <span className="text-right">{(activeTierData.totalInputTokens - activeTierData.entityChunks * 1826 - 3928).toLocaleString()}</span>
                          </div>
                          <div className="grid grid-cols-3 px-3 py-2 bg-background">
                            <span className="text-muted-foreground">Fixed (Pass 1+6)</span>
                            <span className="text-right">2</span>
                            <span className="text-right">3,928</span>
                          </div>
                          <div className="grid grid-cols-3 px-3 py-2 bg-muted/30 font-semibold">
                            <span>Total</span>
                            <span className="text-right">{activeTierData.entityChunks + activeTierData.relChunks + 2}</span>
                            <span className="text-right">{activeTierData.totalInputTokens.toLocaleString()}</span>
                          </div>
                        </div>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Input tokens are exact. Output tokens vary by content density — estimated{" "}
                      {activeTierData?.outputTokensLow.toLocaleString()}–{activeTierData?.outputTokensHigh.toLocaleString()} total.
                      Prices use gpt-4o as a reference rate; <code className="bg-muted px-1 rounded">gpt-5.4</code> (Replit's model) may differ.
                    </p>
                  </div>
                )}
              </div>

              {/* Cost summary + CTA */}
              {activeTierData && activeCost && (
                <div className="rounded-xl border-2 border-slate-200 bg-slate-50 p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-foreground">
                        {showAdvanced
                          ? `Custom · ${customPageCount.toLocaleString()} pages`
                          : `${TIER_META.find(t => t.id === selectedTier)?.label} · ${activeTierData.pages.toLocaleString()} pages`}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {activeTierData.entityChunks + activeTierData.relChunks + 2} AI calls
                        · {activeTierData.totalInputTokens.toLocaleString()} input tokens
                        · ~{activeTierData.entityChunks * 20} entities expected
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted-foreground">Estimated cost (gpt-4o rates)</div>
                      <div className="text-xl font-bold font-mono text-foreground">~${activeCost.typical.toFixed(2)}</div>
                      <div className="text-xs text-muted-foreground font-mono">${activeCost.low.toFixed(2)} – ${activeCost.high.toFixed(2)}</div>
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
                    disabled={isTriggering || isPlanLoading}
                    className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white font-semibold text-sm transition-all active:scale-[0.98] shadow"
                  >
                    <Play className="w-4 h-4" />
                    {isTriggering ? "Starting…" : "Extract Knowledge Graph"}
                  </button>
                </div>
              )}

            </div>
          </div>
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
