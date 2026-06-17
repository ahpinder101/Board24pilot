import { useGetGlobalGraph, useGetGlobalStats } from "@workspace/api-client-react";
import { GraphView } from "@/components/graph-view";
import { Skeleton } from "@/components/ui/skeleton";
import { Database, Network, Clock } from "lucide-react";

export default function GlobalGraphPage() {
  const { data: graphData, isLoading: isLoadingGraph } = useGetGlobalGraph();
  const { data: stats } = useGetGlobalStats();

  return (
    <div className="h-full flex flex-col space-y-4">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 shrink-0">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight text-foreground">
            GLOBAL_GRAPH
          </h1>
          <p className="text-sm text-muted-foreground font-mono mt-1">
            Combined ontology across all processed manuals
          </p>
        </div>

        {stats && (
          <div className="flex items-center gap-4 bg-card border border-border p-2 rounded-md font-mono text-xs shadow-sm">
            <div className="flex items-center gap-2 px-2">
              <Database className="w-4 h-4 text-primary" />
              <div>
                <div className="text-muted-foreground">Total Entities</div>
                <div className="font-bold text-foreground text-sm">{stats.totalEntities}</div>
              </div>
            </div>
            <div className="w-px h-8 bg-border" />
            <div className="flex items-center gap-2 px-2">
              <Network className="w-4 h-4 text-primary" />
              <div>
                <div className="text-muted-foreground">Total Relations</div>
                <div className="font-bold text-foreground text-sm">{stats.totalRelationships}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-[400px]">
        {isLoadingGraph ? (
          <div className="h-full flex items-center justify-center border border-border rounded-lg bg-card/20">
            <div className="flex flex-col items-center gap-4">
              <Clock className="w-8 h-8 text-primary animate-spin" />
              <span className="font-mono text-sm text-muted-foreground">Computing unified layout...</span>
            </div>
          </div>
        ) : graphData ? (
          <GraphView data={graphData} />
        ) : (
          <div className="h-full flex items-center justify-center border border-border border-dashed rounded-lg bg-card/50">
            <span className="font-mono text-sm text-muted-foreground">No graph data available</span>
          </div>
        )}
      </div>
    </div>
  );
}
