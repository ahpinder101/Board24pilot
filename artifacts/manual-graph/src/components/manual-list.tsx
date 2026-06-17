import { useListManuals, useDeleteManual, getListManualsQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileText, Trash2, Network, Clock, AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";

export function ManualList() {
  const { data: manuals, isLoading } = useListManuals();
  const deleteManual = useDeleteManual();
  const queryClient = useQueryClient();

  const handleDelete = async (id: number) => {
    try {
      await deleteManual.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListManualsQueryKey() });
      toast.success("Manual deleted");
    } catch (err) {
      toast.error("Failed to delete manual");
    }
  };

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <Card key={i} className="bg-card border-border">
            <CardHeader>
              <Skeleton className="h-5 w-3/4" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-4 w-1/2" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!manuals?.length) {
    return (
      <div className="text-center py-12 border border-dashed border-border rounded-lg bg-card/50">
        <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <h3 className="text-lg font-medium text-foreground">No manuals uploaded yet</h3>
        <p className="text-sm text-muted-foreground mt-1">Upload a PDF manual to start extracting knowledge.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {manuals.map((manual) => (
        <Card key={manual.id} className="bg-card border-border flex flex-col group transition-colors hover:border-primary/50">
          <CardHeader className="pb-3">
            <div className="flex justify-between items-start gap-4">
              <CardTitle className="text-base font-bold leading-tight line-clamp-2" title={manual.name}>
                {manual.name}
              </CardTitle>
              <Badge 
                variant={manual.status === 'completed' ? 'default' : manual.status === 'failed' ? 'destructive' : 'secondary'}
                className="font-mono text-[10px] uppercase shrink-0"
              >
                {manual.status === 'processing' && <Clock className="w-3 h-3 mr-1 animate-spin" />}
                {manual.status === 'failed' && <AlertTriangle className="w-3 h-3 mr-1" />}
                {manual.status === 'completed' && <CheckCircle2 className="w-3 h-3 mr-1" />}
                {manual.status}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground font-mono mt-2 truncate" title={manual.filename}>
              {manual.filename}
            </div>
          </CardHeader>
          <CardContent className="pb-4 flex-1">
            <div className="text-xs font-mono text-muted-foreground">
              Added {formatDistanceToNow(new Date(manual.createdAt))} ago
            </div>
            {manual.status === 'processing' && (
              <div className="mt-4 p-3 bg-secondary/50 rounded-md border border-border">
                <div className="flex justify-between text-xs font-mono mb-2">
                  <span className="text-muted-foreground">Pass {manual.processingPass || 1}/6</span>
                  <span className="text-primary animate-pulse">Running...</span>
                </div>
                <div className="h-1 bg-background rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-primary transition-all duration-500 ease-out" 
                    style={{ width: `${((manual.processingPass || 1) / 6) * 100}%` }}
                  />
                </div>
              </div>
            )}
            {manual.status === 'failed' && (
              <div className="mt-4 text-xs text-destructive font-mono bg-destructive/10 p-2 rounded border border-destructive/20 line-clamp-2">
                {manual.errorMessage || "Unknown error occurred"}
              </div>
            )}
          </CardContent>
          <CardFooter className="pt-0 flex justify-between items-center border-t border-border/50 p-4">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={() => handleDelete(manual.id)}
              disabled={deleteManual.isPending}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
            <Link href={`/manuals/${manual.id}`}>
              <Button variant="secondary" size="sm" className="font-mono text-xs gap-2">
                <Network className="w-4 h-4" />
                View Graph
                <ChevronRight className="w-3 h-3 opacity-50" />
              </Button>
            </Link>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}
