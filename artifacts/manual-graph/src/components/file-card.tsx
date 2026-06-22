import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle, CheckCircle2, Clock, ExternalLink,
  FileText, Network, Database, RefreshCw, Trash2,
  Activity, WifiOff, Network as GraphIcon, RotateCcw,
  ChevronDown, ChevronUp, Wrench,
} from "lucide-react";
import { useGetManualStats, getGetManualStatsQueryKey, type Manual } from "@workspace/api-client-react";
import { ScopeSelector } from "@/components/scope-selector";
import { cn } from "@/lib/utils";

const STALL_SECONDS = 90;
const PASS_PROGRESS: Record<number, number> = { 0: 5, 1: 15, 2: 28, 3: 40, 4: 58, 5: 72, 6: 86 };

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
  getToken,
  onStarted,
}: {
  manualId: number;
  totalPages: number;
  getToken: () => Promise<string | null>;
  onStarted: () => void;
}) {
  const [pdfLoading, setPdfLoading] = useState(false);
  const [reExtractOpen, setReExtractOpen] = useState(false);
  const { data: stats } = useGetManualStats(manualId, {
    query: { queryKey: getGetManualStatsQueryKey(manualId) },
  });

  const density =
    stats && totalPages > 0
      ? (stats.totalEntities / totalPages).toFixed(1)
      : null;

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
          All 7 passes complete
        </span>
        {density !== null && (
          <span className="text-[11px] text-gray-400 font-mono">~{density} entities/page</span>
        )}
      </div>

      {/* Entity / relationship counts */}
      {stats && (
        <div className="flex items-center gap-3 text-xs font-mono text-gray-500">
          <span className="flex items-center gap-1">
            <Database className="w-3 h-3 text-blue-400" />
            {stats.totalEntities.toLocaleString()} entities
          </span>
          <span className="text-gray-200">|</span>
          <span className="flex items-center gap-1">
            <Network className="w-3 h-3 text-purple-400" />
            {stats.totalRelationships.toLocaleString()} relations
          </span>
        </div>
      )}

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
