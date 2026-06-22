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
import { ScopeSelector } from "@/components/scope-selector";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import {
  Clock, CheckCircle2, AlertTriangle, FileText, Database, Network,
  Layers, RefreshCw, WifiOff, Activity,
} from "lucide-react";
import { useEffect, useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";

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

  useEffect(() => {
    lastUpdatedRef.current = new Date(manual.updatedAt).getTime();
    setSecondsAgo(0);
  }, [manual.updatedAt]);

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

  const PASS_PROGRESS: Record<number, number> = { 0: 5, 1: 15, 2: 28, 3: 40, 4: 58, 5: 72, 6: 86 };
  const progressPct = PASS_PROGRESS[pass] ?? (pass >= 7 ? 100 : 5);

  return (
    <Card className="h-full flex items-center justify-center bg-card/50 border-dashed">
      <CardContent className="flex flex-col items-center justify-center p-10 max-w-lg w-full text-center space-y-5">

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

        <div>
          <h3 className="text-lg font-semibold text-foreground">
            {isStalled ? "Processing appears stalled" : "Processing Manual"}
          </h3>
          <p className="text-sm text-muted-foreground font-mono mt-0.5">
            Pass {pass} · all passes run automatically
          </p>
        </div>

        <Progress
          value={progressPct}
          className={["h-1.5 w-full", isStalled ? "[&>div]:bg-red-400" : ""].join(" ")}
        />

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
  const { getToken } = useAuth();

  const { data: manual, isLoading: isLoadingManual } = useGetManual(manualId, {
    query: {
      enabled: !!manualId,
      queryKey: getGetManualQueryKey(manualId),
      refetchInterval: (query) =>
        query.state.data?.status === "processing" ? 3000 : false,
    }
  });

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
  const showScopeSelector = manual.status === "pending" || manual.status === "structure_complete";

  function invalidateManual() {
    queryClient.invalidateQueries({ queryKey: getGetManualQueryKey(manualId) });
  }

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
              {showScopeSelector                      && <Layers className="w-3 h-3 mr-1" />}
              {manual.status === "structure_complete" ? "Ready" : manual.status}
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

        {/* ── Scope selector ── */}
        {showScopeSelector && (
          <Card className="h-full flex items-center justify-center bg-card/50 border-dashed">
            <CardContent className="flex flex-col items-center p-10 max-w-md w-full space-y-6">
              <ScopeSelector
                manualId={manualId}
                totalPages={totalPages}
                getToken={getToken}
                onStarted={invalidateManual}
              />
            </CardContent>
          </Card>
        )}

        {/* ── Processing ── */}
        {manual.status === "processing" && (
          <ProcessingTicker
            manual={manual}
            manualId={manualId}
            onReset={invalidateManual}
          />
        )}

        {/* ── Failed ── */}
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
              <FailedResetButton manualId={manualId} onReset={invalidateManual} />
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
