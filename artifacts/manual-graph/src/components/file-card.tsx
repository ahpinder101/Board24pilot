import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle, CheckCircle2, ExternalLink,
  FileText, Network, Database, RefreshCw, Trash2,
  Activity, WifiOff, Network as GraphIcon, RotateCcw,
  ChevronDown, ChevronUp, Wrench, Info,
} from "lucide-react";
import { useGetManualStats, getGetManualStatsQueryKey, useReEnrichManual, type Manual } from "@workspace/api-client-react";
import { ScopeSelector } from "@/components/scope-selector";
import { cn } from "@/lib/utils";

const STALL_SECONDS = 90;
const PASS_PROGRESS: Record<number, number> = { 0: 5, 1: 15, 2: 28, 4: 52, 5: 68, 6: 84 };

interface FileCardProps {
  manual: Manual;
  onDelete: (id: number) => void;
  onStarted: () => void;
  getToken: () => Promise<string | null>;
  highlight?: boolean;
}

function ProcessingSection({
  manual,
  manualId,
  getToken,
  onReset,
}: {
  manual: Manual;
  manualId: number;
  getToken: () => Promise<string | null>;
  onReset: () => void;
}) {
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [isResetting, setIsResetting] = useState(false);
  const lastUpdatedRef = useRef(new Date(manual.updatedAt).getTime());

  useEffect(() => {
    lastUpdatedRef.current = new Date(manual.updatedAt).getTime();
    setSecondsAgo(0);
  }, [manual.updatedAt]);

  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastUpdatedRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const isStalled = secondsAgo > STALL_SECONDS;
  const isSlow = secondsAgo > 40;
  const pass = manual.processingPass ?? 0;
  const progressPct = PASS_PROGRESS[pass] ?? (pass >= 7 ? 100 : 5);

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
    <div className="mt-3 space-y-2">
      <div className="space-y-1">
        <div className="flex justify-between items-center text-[11px] font-mono text-gray-400">
          <span className={cn(isStalled ? "text-red-500" : isSlow ? "text-amber-500" : "")}>
            {isStalled ? `Stalled ${secondsAgo}s` : `Pass ${pass} · ${secondsAgo}s ago`}
          </span>
          <span>{progressPct}%</span>
        </div>
        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-700",
              isStalled ? "bg-red-400" : isSlow ? "bg-amber-400" : "bg-blue-500"
            )}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      <div className={cn(
        "flex items-start gap-1.5 rounded border px-2.5 py-2 font-mono text-[11px] leading-relaxed",
        isStalled ? "border-red-200 bg-red-50 text-red-700" : "border-gray-100 bg-gray-50 text-gray-500"
      )}>
        {!isStalled && <span className="mt-0.5 shrink-0 text-green-500 animate-pulse">▶</span>}
        {isStalled && <WifiOff className="w-3 h-3 mt-0.5 shrink-0 text-red-400" />}
        <span className="line-clamp-2">{manual.currentActivity ?? "Initialising…"}</span>
      </div>

      <button
        onClick={handleReset}
        disabled={isResetting}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-all",
          isStalled
            ? "bg-red-600 hover:bg-red-700 text-white"
            : "border border-gray-200 text-gray-400 hover:text-gray-600 hover:border-gray-400",
          isResetting && "opacity-50 cursor-not-allowed"
        )}
      >
        <RefreshCw className={cn("w-3 h-3", isResetting && "animate-spin")} />
        {isResetting ? "Resetting…" : isStalled ? "Reset & Retry" : "Cancel & Reset"}
      </button>
    </div>
  );
}

function CompletedSection({
  manualId,
  totalPages,
  processingPass,
  getToken,
  onStarted,
}: {
  manualId: number;
  totalPages: number;
  processingPass: number;
  getToken: () => Promise<string | null>;
  onStarted: () => void;
}) {
  const [pdfLoading, setPdfLoading] = useState(false);
  const [rechunking, setRechunking] = useState(false);
  const [repairingDiagrams, setRepairingDiagrams] = useState(false);
  const [reExtractOpen, setReExtractOpen] = useState(false);
  const reEnrich = useReEnrichManual({
    mutation: {
      onSuccess: () => {
        toast.success("Re-enrichment started — chunk page context and BOM tables are being updated");
        onStarted();
      },
      onError: () => {
        toast.error("Failed to start re-enrichment — please try again");
      },
    },
  });
  const [costEstimate, setCostEstimate] = useState<{
    estimatedCostUsd: number;
    modelLabel: string;
    inputPer1MUsd: number;
    outputPer1MUsd: number;
    isActual: boolean;
    disclaimer: string;
  } | null>(null);
  const [extractionSummary, setExtractionSummary] = useState<{
    physicalPages: number;
    storedPages: number;
    pagesWithDoclingElements: number;
    pagesAutoEscalatedToVision: number;
  } | null>(null);
  const { data: stats } = useGetManualStats(manualId, {
    query: { queryKey: getGetManualStatsQueryKey(manualId) },
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        const [costRes, manualRes] = await Promise.all([
          fetch(`/api/manuals/${manualId}/cost-estimate`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }),
          fetch(`/api/manuals/${manualId}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }),
        ]);
        if (!cancelled && costRes.ok) setCostEstimate(await costRes.json());
        if (!cancelled && manualRes.ok) {
          const data = await manualRes.json() as {
            extractionSummary?: {
              physicalPages: number;
              storedPages: number;
              pagesWithDoclingElements: number;
              pagesAutoEscalatedToVision: number;
            }
          };
          if (data.extractionSummary) setExtractionSummary(data.extractionSummary);
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [manualId, getToken]);

  const density =
    stats && totalPages > 0
      ? (stats.totalEntities / totalPages).toFixed(1)
      : null;

  async function repairDiagramPages() {
    setRepairingDiagrams(true);
    try {
      const token = await getToken();
      const res = await fetch(`/api/manuals/${manualId}/repair-diagram-pages`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json() as { repairedPages: number; message: string };
      if (data.repairedPages === 0) {
        toast.info("No diagram pages needed repair");
      } else {
        toast.success(`Repairing ${data.repairedPages} diagram pages with Vision OCR — this may take a few minutes`);
        onStarted();
      }
    } catch {
      toast.error("Diagram repair failed — please try again");
    } finally {
      setRepairingDiagrams(false);
    }
  }

  async function rechunkPages() {
    setRechunking(true);
    try {
      const token = await getToken();
      const res = await fetch(`/api/manuals/${manualId}/rechunk`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json() as { chunks: number };
      toast.success(`Re-chunked — ${data.chunks} chunks indexed`);
      onStarted();
    } catch {
      toast.error("Re-chunk failed — please try again");
    } finally {
      setRechunking(false);
    }
  }

  async function openPdf() {
    setPdfLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(`/api/manuals/${manualId}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), "_blank", "noopener,noreferrer");
    } catch {
      toast.error("Could not open PDF — please try again");
    } finally {
      setPdfLoading(false);
    }
  }

  function handleStarted() {
    setReExtractOpen(false);
    onStarted();
  }

  return (
    <div className="mt-3 space-y-2.5">
      {/* Confidence badge + stats row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1 rounded-full bg-green-50 border border-green-200 px-2 py-0.5 text-[11px] font-medium text-green-700">
          <CheckCircle2 className="w-3 h-3" />
          Processing complete
        </span>
        {processingPass < 8 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] font-medium text-amber-700">
            <Wrench className="w-3 h-3" />
            Enrich pending
          </span>
        )}
        {density !== null && (
          <span className="text-[11px] text-gray-400 font-mono">~{density} entities/page</span>
        )}
      </div>

      {/* Entity / relationship counts + cost estimate */}
      {stats && (
        <div className="flex items-center gap-3 text-xs font-mono text-gray-500 flex-wrap">
          <span className="flex items-center gap-1">
            <Database className="w-3 h-3 text-blue-400" />
            {stats.totalEntities.toLocaleString()} entities
          </span>
          <span className="text-gray-200">|</span>
          <span className="flex items-center gap-1">
            <Network className="w-3 h-3 text-purple-400" />
            {stats.totalRelationships.toLocaleString()} relations
          </span>
          {costEstimate && (
            <>
              <span className="text-gray-200">|</span>
              <span
                className="flex items-center gap-0.5 cursor-help"
                title={`Est. processing cost — Model: ${costEstimate.modelLabel} · $${costEstimate.inputPer1MUsd.toFixed(2)}/1M input · $${costEstimate.outputPer1MUsd.toFixed(2)}/1M output\n\n${costEstimate.disclaimer}`}
              >
                ~${costEstimate.estimatedCostUsd.toFixed(2)}
                <Info className="w-2.5 h-2.5 text-gray-300" />
              </span>
            </>
          )}
        </div>
      )}

      {/* Page coverage bar */}
      {extractionSummary && extractionSummary.physicalPages > 0 && (() => {
        const physical = extractionSummary.physicalPages;
        const stored = extractionSummary.storedPages;
        const docling = extractionSummary.pagesWithDoclingElements;
        const vision = extractionSummary.pagesAutoEscalatedToVision;
        const hasBreakdown = docling + vision > 0;
        const skipped = Math.max(0, physical - stored);
        // When breakdown flags aren't set (legacy rows), show stored as one block
        const doclingPct = hasBreakdown ? (docling / physical) * 100 : (stored / physical) * 100;
        const visionPct = hasBreakdown ? (vision / physical) * 100 : 0;
        const skippedPct = (skipped / physical) * 100;
        return (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] text-gray-500">
              <span className="font-medium">Page coverage</span>
              <span className="font-mono">
                {stored} / {physical} extracted
                {skipped > 0 && <span className="text-red-400 ml-1">· {skipped} skipped</span>}
              </span>
            </div>
            <div
              className="h-2 w-full rounded-full overflow-hidden flex bg-gray-100"
              title={hasBreakdown
                ? `Docling: ${docling} · Vision OCR: ${vision} · Skipped (CAD only): ${skipped}`
                : `Extracted: ${stored} · Skipped (CAD only): ${skipped}`}
            >
              {doclingPct > 0 && (
                <div className="h-full bg-green-400 transition-all" style={{ width: `${doclingPct}%` }} />
              )}
              {visionPct > 0 && (
                <div className="h-full bg-amber-400 transition-all" style={{ width: `${visionPct}%` }} />
              )}
              {skippedPct > 0 && (
                <div className="h-full bg-red-200 transition-all" style={{ width: `${skippedPct}%` }} />
              )}
            </div>
            <div className="flex items-center gap-3 text-[10px] text-gray-400">
              {hasBreakdown ? (
                <>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-400 inline-block" />Docling ({docling})</span>
                  {vision > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />Vision OCR ({vision})</span>}
                </>
              ) : (
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-400 inline-block" />Extracted ({stored})</span>
              )}
              {skipped > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-200 inline-block" />Skipped ({skipped})</span>}
            </div>
          </div>
        );
      })()}

      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        <Link href={`/manuals/${manualId}`}>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition-all shadow-sm">
            <GraphIcon className="w-3.5 h-3.5" />
            View Graph
          </button>
        </Link>
        <button
          onClick={openPdf}
          disabled={pdfLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:text-gray-900 hover:border-gray-400 text-xs font-medium transition-all disabled:opacity-50"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          {pdfLoading ? "Opening…" : "Open PDF"}
        </button>
        {processingPass < 8 && (
          <button
            onClick={() => reEnrich.mutate({ id: manualId })}
            disabled={reEnrich.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 text-xs font-medium transition-all disabled:opacity-50"
            title="Re-run Pass 8: backfill page context labels and expand BOM tables for all chunks"
          >
            <Wrench className={cn("w-3.5 h-3.5", reEnrich.isPending && "animate-spin")} />
            {reEnrich.isPending ? "Enriching…" : "Re-enrich chunks"}
          </button>
        )}
        <button
          onClick={rechunkPages}
          disabled={rechunking}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 text-xs font-medium transition-all disabled:opacity-50"
          title="Re-index all page text as searchable chunks — use after the pipeline runs to fix missing content"
        >
          <Database className={cn("w-3.5 h-3.5", rechunking && "animate-spin")} />
          {rechunking ? "Re-chunking…" : "Re-chunk"}
        </button>
        <button
          onClick={repairDiagramPages}
          disabled={repairingDiagrams}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 text-xs font-medium transition-all disabled:opacity-50"
          title="Run Vision OCR on weak or skipped diagram pages — recovers schematic content Docling couldn't extract"
        >
          <Activity className={cn("w-3.5 h-3.5", repairingDiagrams && "animate-spin")} />
          {repairingDiagrams ? "Repairing…" : "Repair diagrams"}
        </button>
        <button
          onClick={() => setReExtractOpen((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-gray-800 hover:border-gray-400 text-xs font-medium transition-all ml-auto"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Re-extract pages
          {reExtractOpen
            ? <ChevronUp className="w-3 h-3" />
            : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {/* Collapsible re-extract scope selector */}
      {reExtractOpen && (
        <div className="pt-2 border-t border-gray-100">
          <ScopeSelector
            manualId={manualId}
            totalPages={totalPages}
            getToken={getToken}
            onStarted={handleStarted}
            compact
          />
        </div>
      )}
    </div>
  );
}

function FailedSection({
  manualId,
  errorMessage,
  getToken,
  onReset,
}: {
  manualId: number;
  errorMessage?: string | null;
  getToken: () => Promise<string | null>;
  onReset: () => void;
}) {
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
    <div className="mt-3 space-y-2">
      {errorMessage && (
        <p className="text-[11px] font-mono text-red-600 bg-red-50 border border-red-200 rounded px-2.5 py-1.5 line-clamp-2">
          {errorMessage}
        </p>
      )}
      <button
        onClick={handleReset}
        disabled={isResetting}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold transition-all disabled:opacity-50"
      >
        <RefreshCw className={cn("w-3.5 h-3.5", isResetting && "animate-spin")} />
        {isResetting ? "Resetting…" : "Reset & Retry"}
      </button>
    </div>
  );
}

function RepairGraphButton({
  manualId,
  getToken,
  onStarted,
}: {
  manualId: number;
  getToken: () => Promise<string | null>;
  onStarted: () => void;
}) {
  const [isRepairing, setIsRepairing] = useState(false);

  async function handleRepair() {
    setIsRepairing(true);
    try {
      const token = await getToken();
      const res = await fetch(`/api/manuals/${manualId}/repair-graph`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        toast.success("Graph repair started — relationship and path extraction running");
        onStarted();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error((data as { error?: string }).error ?? "Failed to start repair");
      }
    } catch {
      toast.error("Network error — please try again");
    } finally {
      setIsRepairing(false);
    }
  }

  return (
    <button
      onClick={handleRepair}
      disabled={isRepairing}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 text-xs font-medium transition-all disabled:opacity-50 mt-2"
    >
      <Wrench className={cn("w-3.5 h-3.5", isRepairing && "animate-spin")} />
      {isRepairing ? "Repairing graph…" : "Repair graph (re-run relationships & paths)"}
    </button>
  );
}

export function FileCard({ manual, onDelete, onStarted, getToken, highlight = false }: FileCardProps) {
  const showScopeSelector = manual.status === "pending" || manual.status === "structure_complete";
  const isProcessing = manual.status === "processing";
  const isCompleted = manual.status === "completed";
  const isFailed = manual.status === "failed";

  const statusIcon = isCompleted ? (
    <CheckCircle2 className="w-4 h-4 text-green-500" />
  ) : isFailed ? (
    <AlertTriangle className="w-4 h-4 text-red-500" />
  ) : isProcessing ? (
    <Activity className="w-4 h-4 text-blue-500 animate-pulse" />
  ) : (
    <FileText className="w-4 h-4 text-gray-400" />
  );

  const borderClass = highlight
    ? "border-blue-400 ring-2 ring-blue-300 ring-offset-1"
    : isCompleted
    ? "border-green-100"
    : isFailed
    ? "border-red-200"
    : isProcessing
    ? "border-blue-100"
    : showScopeSelector
    ? "border-amber-100"
    : "border-gray-100";

  const bgClass = isCompleted
    ? "bg-green-50/30"
    : isFailed
    ? "bg-red-50/30"
    : isProcessing
    ? "bg-blue-50/30"
    : showScopeSelector
    ? "bg-amber-50/40"
    : "bg-white";

  return (
    <div className={cn("rounded-lg border p-3.5 transition-all duration-500", borderClass, bgClass)}>
      <div className="flex items-start gap-2.5">
        <div className={cn(
          "w-7 h-7 rounded flex items-center justify-center shrink-0 mt-0.5",
          isCompleted ? "bg-green-100" : isFailed ? "bg-red-100" : isProcessing ? "bg-blue-100" : "bg-gray-100"
        )}>
          {statusIcon}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-800 truncate leading-snug">{manual.name}</p>
          <p className="text-[11px] text-gray-400 mt-0.5 font-mono truncate">
            {manual.filename}
            {manual.totalPages ? ` · ${manual.totalPages} pages` : ""}
            {manual.documentType ? ` · ${manual.documentType.replace(/_/g, " ")}` : ""}
          </p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Uploaded {formatDistanceToNow(new Date(manual.createdAt))} ago
          </p>
        </div>

        <button
          onClick={() => onDelete(manual.id)}
          className="w-7 h-7 flex items-center justify-center rounded text-gray-300 hover:text-red-500 hover:bg-red-50 transition-all shrink-0"
          title="Delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {showScopeSelector && (
        <div className="mt-2 pt-3 border-t border-amber-100">
          <ScopeSelector
            manualId={manual.id}
            totalPages={manual.totalPages ?? 0}
            getToken={getToken}
            onStarted={onStarted}
            compact
          />
          {(manual.processingPass ?? 0) >= 4 && (manual.processingPass ?? 0) < 7 && (
            <RepairGraphButton
              manualId={manual.id}
              getToken={getToken}
              onStarted={onStarted}
            />
          )}
        </div>
      )}

      {isProcessing && (
        <ProcessingSection
          manual={manual}
          manualId={manual.id}
          getToken={getToken}
          onReset={onStarted}
        />
      )}

      {isCompleted && (
        <CompletedSection
          manualId={manual.id}
          totalPages={manual.totalPages ?? 0}
          processingPass={manual.processingPass ?? 0}
          getToken={getToken}
          onStarted={onStarted}
        />
      )}

      {isFailed && (
        <FailedSection
          manualId={manual.id}
          errorMessage={manual.errorMessage}
          getToken={getToken}
          onReset={onStarted}
        />
      )}
    </div>
  );
}
