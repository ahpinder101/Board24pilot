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
import { Clock, CheckCircle2, AlertTriangle, FileText, Database, Network } from "lucide-react";
import { useEffect, useState } from "react";

export default function ManualGraphPage() {
  const { id } = useParams<{ id: string }>();
  const manualId = parseInt(id, 10);
  
  // Use poll interval if manual is processing
  const [pollInterval, setPollInterval] = useState<number | undefined>(undefined);
  
  const { data: manual, isLoading: isLoadingManual } = useGetManual(manualId, {
    query: {
      enabled: !!manualId,
      queryKey: getGetManualQueryKey(manualId),
      refetchInterval: pollInterval
    }
  });

  useEffect(() => {
    if (manual?.status === 'processing') {
      setPollInterval(3000);
    } else {
      setPollInterval(undefined);
    }
  }, [manual?.status]);

  const { data: graphData, isLoading: isLoadingGraph } = useGetManualGraph(manualId, {
    query: {
      queryKey: getGetManualGraphQueryKey(manualId),
      enabled: !!manualId && manual?.status === 'completed',
    }
  });

  const { data: stats } = useGetManualStats(manualId, {
    query: {
      queryKey: getGetManualStatsQueryKey(manualId),
      enabled: !!manualId && manual?.status === 'completed',
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

  return (
    <div className="h-full flex flex-col space-y-4 relative">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 shrink-0">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold font-mono tracking-tight text-foreground truncate max-w-xl">
              {manual.name}
            </h1>
            <Badge 
              variant={manual.status === 'completed' ? 'default' : manual.status === 'failed' ? 'destructive' : 'secondary'}
              className="font-mono text-xs uppercase"
            >
              {manual.status === 'processing' && <Clock className="w-3 h-3 mr-1 animate-spin" />}
              {manual.status === 'failed' && <AlertTriangle className="w-3 h-3 mr-1" />}
              {manual.status === 'completed' && <CheckCircle2 className="w-3 h-3 mr-1" />}
              {manual.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground font-mono flex items-center gap-2">
            <FileText className="w-4 h-4" /> {manual.filename}
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
        {manual.status === 'processing' && (
          <Card className="h-full flex items-center justify-center bg-card/50 border-dashed">
            <CardContent className="flex flex-col items-center justify-center p-12 max-w-md w-full text-center space-y-6">
              <Clock className="w-12 h-12 text-primary animate-pulse" />
              <div className="w-full">
                <h3 className="text-lg font-medium text-foreground mb-1">Processing Manual</h3>
                <p className="text-sm text-muted-foreground font-mono mb-4">
                  Pass {manual.processingPass || 1} of 6
                </p>
                <Progress value={((manual.processingPass || 1) / 6) * 100} className="h-2 w-full mb-2" />
                <div className="text-xs text-muted-foreground font-mono text-left opacity-70">
                  {manual.processingPass === 1 && "Extracting document structure..."}
                  {manual.processingPass === 2 && "Parsing page content & text..."}
                  {manual.processingPass === 3 && "Analyzing images and tables..."}
                  {manual.processingPass === 4 && "Extracting engineering entities..."}
                  {manual.processingPass === 5 && "Mapping component relationships..."}
                  {manual.processingPass === 6 && "Finalizing hierarchy..."}
                  {!manual.processingPass && "Initializing..."}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {manual.status === 'failed' && (
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

        {manual.status === 'completed' && isLoadingGraph && (
          <div className="h-full flex items-center justify-center border border-border rounded-lg bg-card/20">
            <div className="flex flex-col items-center gap-4">
              <Clock className="w-8 h-8 text-primary animate-spin" />
              <span className="font-mono text-sm text-muted-foreground">Loading graph layout...</span>
            </div>
          </div>
        )}

        {manual.status === 'completed' && graphData && (
          <GraphView data={graphData} />
        )}
      </div>
    </div>
  );
}
