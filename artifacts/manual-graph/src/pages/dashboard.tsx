import { useState, useEffect } from "react";
import { useGetGlobalStats, useListManuals, useDeleteManual, getListManualsQueryKey } from "@workspace/api-client-react";
import { UploadPDF } from "@/components/upload-pdf";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@clerk/react";
import {
  BookOpen,
  MessageSquare,
  RefreshCw,
  Clock,
  FileText,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  Layers,
  Sparkles,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  getRecentQuestions,
  countQuestionsThisWeek,
  type RecentQuestion,
} from "@/hooks/use-recent-questions";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function StatCard({
  value,
  label,
  sub,
  accent,
}: {
  value: React.ReactNode;
  label: string;
  sub?: string;
  accent?: "blue" | "purple" | "orange" | "teal";
}) {
  const colours = {
    blue: "text-blue-600",
    purple: "text-purple-600",
    orange: "text-orange-500",
    teal: "text-teal-600",
  };
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-1">
      <div className={cn("text-2xl sm:text-3xl font-bold", colours[accent ?? "blue"])}>{value}</div>
      <div className="text-xs sm:text-sm font-medium text-gray-700">{label}</div>
      {sub && <div className="text-[11px] text-gray-400">{sub}</div>}
    </div>
  );
}

function ManualRow({ manual, onDelete, getToken }: { manual: any; onDelete: (id: number) => void; getToken: () => Promise<string | null> }) {
  const isReady = manual.status === "structure_complete";
  const isPending = manual.status === "pending";
  const [pdfLoading, setPdfLoading] = useState(false);

  async function openPdf() {
    setPdfLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(`/api/manuals/${manual.id}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      toast.error("Could not open PDF — please try again");
    } finally {
      setPdfLoading(false);
    }
  }

  return (
    <div className={cn(
      "flex items-center gap-3 py-3 border-b border-gray-100 last:border-0",
      isReady && "bg-amber-50 -mx-4 px-4 sm:-mx-5 sm:px-5 rounded-lg border-amber-100",
      isPending && "bg-gray-50 -mx-4 px-4 sm:-mx-5 sm:px-5 rounded-lg"
    )}>
      <div className={cn(
        "w-8 h-8 rounded flex items-center justify-center shrink-0",
        isReady ? "bg-amber-100" : isPending ? "bg-gray-100" : "bg-blue-50"
      )}>
        {isReady
          ? <Layers className="w-4 h-4 text-amber-600" />
          : isPending
            ? <FileText className="w-4 h-4 text-gray-400" />
            : <FileText className="w-4 h-4 text-blue-500" />
        }
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800 truncate">{manual.name}</p>
        <p className="text-xs text-gray-400 mt-0.5">
          Added {formatDistanceToNow(new Date(manual.createdAt))} ago
        </p>
        {manual.status === "processing" && (
          <div className="mt-1.5">
            <div className="h-1 bg-gray-100 rounded-full overflow-hidden w-24">
              <div
                className="h-full bg-blue-500 transition-all duration-500 rounded-full"
                style={{ width: `${((manual.processingPass || 1) / 7) * 100}%` }}
              />
            </div>
            <p className="text-[10px] text-gray-400 mt-0.5">Pass {manual.processingPass || 1}/7</p>
          </div>
        )}
        {isReady && (
          <Link href={`/manuals/${manual.id}`}>
            <button className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-amber-700 hover:text-amber-900">
              <Sparkles className="w-3 h-3" />
              See cost estimate &amp; extract graph →
            </button>
          </Link>
        )}
        {isPending && (
          <Link href={`/manuals/${manual.id}`}>
            <button className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-gray-500 hover:text-gray-800">
              <Play className="w-3 h-3" />
              Start processing →
            </button>
          </Link>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {manual.status === "completed" && (
          <CheckCircle2 className="w-4 h-4 text-green-500" />
        )}
        {manual.status === "failed" && (
          <AlertTriangle className="w-4 h-4 text-red-500" />
        )}
        {manual.status === "processing" && (
          <Clock className="w-4 h-4 text-blue-400 animate-spin" />
        )}
        {isReady && (
          <Link href={`/manuals/${manual.id}`}>
            <Button
              variant="ghost"
              size="icon"
              className="w-8 h-8 text-amber-400 hover:text-amber-700 hover:bg-amber-100"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </Link>
        )}
        {isPending && (
          <Link href={`/manuals/${manual.id}`}>
            <Button
              variant="ghost"
              size="icon"
              className="w-8 h-8 text-gray-300 hover:text-gray-600 hover:bg-gray-100"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </Link>
        )}
        {manual.status === "completed" && (
          <Button
            variant="ghost"
            size="icon"
            className="w-8 h-8 text-gray-300 hover:text-blue-600 hover:bg-blue-50"
            title="Open PDF"
            onClick={openPdf}
            disabled={pdfLoading}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="w-8 h-8 text-gray-300 hover:text-red-500 hover:bg-red-50"
          onClick={() => onDelete(manual.id)}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { getToken } = useAuth();
  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useGetGlobalStats();
  const { data: manuals, isLoading: manualsLoading, refetch: refetchManuals } = useListManuals();
  const deleteManual = useDeleteManual();
  const queryClient = useQueryClient();
  const [recentQs, setRecentQs] = useState<RecentQuestion[]>([]);
  const [weekCount, setWeekCount] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    setRecentQs(getRecentQuestions());
    setWeekCount(countQuestionsThisWeek());
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([refetchStats(), refetchManuals()]);
    setRecentQs(getRecentQuestions());
    setWeekCount(countQuestionsThisWeek());
    setIsRefreshing(false);
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteManual.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListManualsQueryKey() });
      toast.success("Manual deleted");
    } catch {
      toast.error("Failed to delete manual");
    }
  };

  const lastQ = recentQs[0];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-8 w-full space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            {greeting()}, Engineer.
          </h1>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs sm:text-sm text-gray-400">Knowledge Base</span>
            <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 text-[10px] px-1.5 py-0 font-medium">
              Admin
            </Badge>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-gray-600 shrink-0"
          onClick={handleRefresh}
          disabled={isRefreshing}
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isRefreshing && "animate-spin")} />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {statsLoading ? (
          [1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white rounded-lg border border-gray-200 p-4">
              <Skeleton className="h-7 w-12 mb-2" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))
        ) : (
          <>
            <StatCard
              value={stats?.totalManuals ?? 0}
              label="Documents"
              sub={`${stats?.completedManuals ?? 0} completed`}
              accent="blue"
            />
            <StatCard
              value={weekCount}
              label="Questions this week"
              sub={weekCount === 0 ? "None yet" : "From Ask Engineer"}
              accent="purple"
            />
            <StatCard
              value={(stats?.totalEntities ?? 0).toLocaleString()}
              label="Entities extracted"
              sub={`${(stats?.totalRelationships ?? 0).toLocaleString()} relationships`}
              accent="orange"
            />
            <div className="bg-teal-50 rounded-lg border border-teal-100 p-4 flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-teal-600 text-xs font-semibold mb-1">
                <MessageSquare className="w-3.5 h-3.5" />
                Last question
              </div>
              {lastQ ? (
                <>
                  <p className="text-xs sm:text-sm font-medium text-gray-800 line-clamp-2 leading-snug">
                    "{lastQ.question}"
                  </p>
                  <p className="text-xs text-teal-500">
                    {formatDistanceToNow(new Date(lastQ.timestamp))} ago
                  </p>
                </>
              ) : (
                <p className="text-xs sm:text-sm text-gray-400 italic">No questions asked yet</p>
              )}
            </div>
          </>
        )}
      </div>

      {/* Main panels */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 sm:gap-6">
        {/* Knowledge Base */}
        <div className="lg:col-span-3 bg-white rounded-lg border border-gray-200">
          <div className="flex items-center gap-2 px-4 sm:px-5 py-3.5 border-b border-gray-100">
            <BookOpen className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-semibold text-gray-700">Knowledge Base</h2>
          </div>
          <div className="p-4 sm:p-5 space-y-4">
            {manualsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex gap-3 items-center">
                    <Skeleton className="w-8 h-8 rounded" />
                    <div className="flex-1">
                      <Skeleton className="h-4 w-3/4 mb-1" />
                      <Skeleton className="h-3 w-1/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : manuals?.length ? (
              <div>
                {manuals.map((manual) => (
                  <ManualRow key={manual.id} manual={manual} onDelete={handleDelete} getToken={getToken} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center mb-3">
                  <BookOpen className="w-5 h-5 text-gray-300" />
                </div>
                <p className="text-sm text-gray-500 font-medium">No documents uploaded yet</p>
                <p className="text-xs text-gray-400 mt-1">Upload a PDF to get started</p>
              </div>
            )}

            <div className="pt-2 border-t border-gray-100">
              <UploadPDF />
            </div>
          </div>
        </div>

        {/* Recent Questions */}
        <div className="lg:col-span-2 bg-white rounded-lg border border-gray-200">
          <div className="flex items-center gap-2 px-4 sm:px-5 py-3.5 border-b border-gray-100">
            <MessageSquare className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-semibold text-gray-700">Recent Questions</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {recentQs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center px-5">
                <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center mb-3">
                  <MessageSquare className="w-5 h-5 text-gray-300" />
                </div>
                <p className="text-sm text-gray-500 font-medium">No questions yet</p>
                <p className="text-xs text-gray-400 mt-1">Use Ask Engineer to query your documents</p>
                <Link href="/ask">
                  <Button variant="outline" size="sm" className="mt-4 text-xs gap-1.5">
                    <MessageSquare className="w-3.5 h-3.5" />
                    Go to Ask Engineer
                  </Button>
                </Link>
              </div>
            ) : (
              recentQs.slice(0, 12).map((q) => (
                <div key={q.id} className="px-4 sm:px-5 py-3">
                  <p className="text-sm text-gray-700 leading-snug">{q.question}</p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <Clock className="w-3 h-3 text-gray-300" />
                    <span className="text-[11px] text-gray-400">
                      {formatDistanceToNow(new Date(q.timestamp))} ago
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
          {recentQs.length > 0 && (
            <div className="px-4 sm:px-5 py-3 border-t border-gray-100">
              <Link href="/ask">
                <Button variant="ghost" size="sm" className="text-xs text-gray-500 gap-1.5 w-full justify-center hover:text-blue-600">
                  Open Ask Engineer
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
