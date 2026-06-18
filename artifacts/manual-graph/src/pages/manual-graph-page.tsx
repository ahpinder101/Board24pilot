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
import { Clock, CheckCircle2, AlertTriangle, FileText, Database, Network, Layers, Play, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

const PAGES_PER_ENTITY_CHUNK = 12;  // ~5,000 chars / ~400 chars per page
const PAGES_PER_REL_CHUNK = 10;     // ~4,000 chars / ~400 chars per page

function pagesToChunks(pages: number, charsPerChunk: number) {
  return Math.max(1, Math.ceil(pages / (charsPerChunk / 400)));
}

function estimateCost(entityChunks: number, relChunks: number): string {
  // Rough estimate: each chunk call ~$0.05–0.15 at gpt-4o-ish pricing
  const calls = entityChunks + relChunks + 2; // +2 for pass1 + pass6
  const low = (calls * 0.05).toFixed(0);
  const high = (calls * 0.15).toFixed(0);
  return `~$${low}–$${high}`;
}

export default function ManualGraphPage() {
  const { id } = useParams<{ id: string }>();
  const manualId = parseInt(id, 10);
  const queryClient = useQueryClient();

  const [pollInterval, setPollInterval] = useState<number | undefined>(undefined);
  const [pagesToCover, setPagesToCover] = useState<number>(100);
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

  // Initialise the page slider to a sensible default once we know total pages
  useEffect(() => {
    if (manual?.totalPages) {
      setPagesToCover(Math.min(150, manual.totalPages));
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
  const entityChunks = pagesToChunks(pagesToCover, 5000);
  const relChunks = Math.max(1, Math.ceil(entityChunks * 0.75));

  async function handleExtractEntities() {
    setIsTriggering(true);
    setExtractError("");
    try {
      const res = await fetch(`/api/manuals/${manualId}/extract-graph`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityChunks, relChunks }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Start polling — the API sets status to "processing"
      setPollInterval(3000);
      // Invalidate manual query so the badge updates immediately
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
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 shrink-0">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold font-mono tracking-tight text-foreground truncate max-w-xl">
              {manual.name}
            </h1>
            <Badge
              variant={
                manual.status === "completed" ? "default" :
                manual.status === "failed" ? "destructive" :
                "secondary"
              }
              className="font-mono text-xs uppercase"
            >
              {manual.status === "processing" && <Clock className="w-3 h-3 mr-1 animate-spin" />}
              {manual.status === "failed" && <AlertTriangle className="w-3 h-3 mr-1" />}
              {manual.status === "completed" && <CheckCircle2 className="w-3 h-3 mr-1" />}
              {manual.status === "structure_complete" && <Layers className="w-3 h-3 mr-1" />}
              {manual.status === "structure_complete" ? "Ready for extraction" : manual.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground font-mono flex items-center gap-2">
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

        {/* ── Processing spinner ── */}
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
                  {manual.processingPass === 3 && "Analyzing images and tables..."}
                  {manual.processingPass === 4 && "Extracting engineering entities..."}
                  {manual.processingPass === 5 && "Mapping component relationships..."}
                  {manual.processingPass === 6 && "Finalizing hierarchy..."}
                  {manual.processingPass === 7 && "Indexing text for search (RAG)..."}
                  {!manual.processingPass && "Initializing..."}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Structure complete — awaiting entity extraction ── */}
        {manual.status === "structure_complete" && (
          <Card className="h-full flex items-center justify-center bg-card/50 border-dashed border-blue-200">
            <CardContent className="flex flex-col items-center p-10 max-w-lg w-full text-center space-y-6">
              <div className="flex flex-col items-center gap-2">
                <CheckCircle2 className="w-10 h-10 text-green-500" />
                <h3 className="text-lg font-semibold text-foreground">Structure Ready</h3>
                <p className="text-sm text-muted-foreground">
                  Pages indexed for search. Now choose how much of the document to analyse for the knowledge graph.
                </p>
              </div>

              <div className="w-full bg-muted/40 rounded-xl p-5 space-y-4 text-left border border-border">
                <div className="flex items-start gap-2 text-xs text-muted-foreground bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                  <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-400" />
                  <span>More pages = richer graph, more AI calls, higher cost. You can always re-run with a higher value later.</span>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium text-foreground">Pages to cover for entity extraction</label>
                    <span className="font-mono text-sm font-bold text-primary">{Math.min(pagesToCover, totalPages).toLocaleString()} / {totalPages.toLocaleString()}</span>
                  </div>
                  <input
                    type="range"
                    min={Math.min(30, totalPages)}
                    max={totalPages || 1800}
                    step={10}
                    value={Math.min(pagesToCover, totalPages)}
                    onChange={(e) => setPagesToCover(Number(e.target.value))}
                    className="w-full accent-slate-700"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>30 pages (quick)</span>
                    <span>{(totalPages || 1800).toLocaleString()} pages (full)</span>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3 text-center text-xs">
                  <div className="bg-background rounded-lg border border-border p-3">
                    <div className="text-muted-foreground mb-1">Entity chunks</div>
                    <div className="font-mono font-bold text-foreground">{entityChunks}</div>
                    <div className="text-muted-foreground/60">AI calls</div>
                  </div>
                  <div className="bg-background rounded-lg border border-border p-3">
                    <div className="text-muted-foreground mb-1">Relation chunks</div>
                    <div className="font-mono font-bold text-foreground">{relChunks}</div>
                    <div className="text-muted-foreground/60">AI calls</div>
                  </div>
                  <div className="bg-background rounded-lg border border-border p-3">
                    <div className="text-muted-foreground mb-1">Est. cost</div>
                    <div className="font-mono font-bold text-foreground">{estimateCost(entityChunks, relChunks)}</div>
                    <div className="text-muted-foreground/60">approx</div>
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
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white font-semibold text-sm transition-all active:scale-[0.98]"
                >
                  <Play className="w-4 h-4" />
                  {isTriggering ? "Starting…" : `Extract Entities (${Math.min(pagesToCover, totalPages).toLocaleString()} pages)`}
                </button>
              </div>
            </CardContent>
          </Card>
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
