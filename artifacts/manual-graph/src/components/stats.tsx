import { useGetGlobalStats } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Database, Network, FileText, Activity } from "lucide-react";

export function GlobalStatsDashboard() {
  const { data: stats, isLoading } = useGetGlobalStats();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i} className="bg-card border-border">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-[100px]" />
              <Skeleton className="h-4 w-4" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-[60px]" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!stats) return null;

  const statItems = [
    {
      title: "Total Manuals",
      value: stats.totalManuals,
      icon: FileText,
      description: `${stats.completedManuals} completed`,
    },
    {
      title: "Processing",
      value: stats.processingManuals,
      icon: Activity,
      description: "Active jobs",
    },
    {
      title: "Total Entities",
      value: stats.totalEntities.toLocaleString(),
      icon: Database,
      description: "Extracted nodes",
    },
    {
      title: "Relationships",
      value: stats.totalRelationships.toLocaleString(),
      icon: Network,
      description: "Mapped edges",
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
      {statItems.map((item, i) => (
        <Card key={i} className="bg-card border-border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground font-mono">
              {item.title}
            </CardTitle>
            <item.icon className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-foreground">{item.value}</div>
            <p className="text-xs text-muted-foreground font-mono mt-1">
              {item.description}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
