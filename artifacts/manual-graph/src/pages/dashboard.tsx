import { useState, useEffect, useRef, useCallback } from "react";
import {
  useGetGlobalStats,
  useListManuals,
  useDeleteManual,
  getListManualsQueryKey,
} from "@workspace/api-client-react";
import { UploadPDF, type UploadPDFRef } from "@/components/upload-pdf";
import { FileCard } from "@/components/file-card";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@clerk/react";
import {
  BookOpen,
  FolderOpen,
  MessageSquare,
  RefreshCw,
  Clock,
  ChevronRight,
  Sparkles,
  UploadCloud,
  ScanLine,
  Loader2,
  ChevronDown,
  BarChart2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// ── Domain Coverage types ─────────────────────────────────────────────────────

interface DomainScore {
  domain: string;
  label: string;
  score: number;
  chunkHits: number;
  entityCount: number;
}

interface SectionCoverage {
  name: string;
  weightedChunks: number;
  primaryDomain: string;
  label: string;
}

interface ManualDomainCoverage {
  manualId: number;
  manualName: string;
  domains: DomainScore[];
  primaryDomain: string;
  totalChunks: number;
  totalEntities: number;
  sections?: SectionCoverage[];
}

interface DomainCoverageReport {
  manuals: ManualDomainCoverage[];
  globalDomains: DomainScore[];
  totalManuals: number;
  scannedAt: string;
}

const DOMAIN_COLOURS: Record<string, { bar: string; text: string; bg: string }> = {
  electrical_control: { bar: "bg-blue-500",    text: "text-blue-700",   bg: "bg-blue-50"   },
  hydraulic_schematic:{ bar: "bg-cyan-500",    text: "text-cyan-700",   bg: "bg-cyan-50"   },
  pneumatic_schematic:{ bar: "bg-sky-400",     text: "text-sky-700",    bg: "bg-sky-50"    },
  mechanical_assembly:{ bar: "bg-orange-400",  text: "text-orange-700", bg: "bg-orange-50" },
  troubleshooting:    { bar: "bg-red-400",     text: "text-red-700",    bg: "bg-red-50"    },
  process_procedure:  { bar: "bg-emerald-500", text: "text-emerald-700",bg: "bg-emerald-50"},
};

function DomainBar({ domain, compact = false }: { domain: DomainScore; compact?: boolean }) {
  const colours = DOMAIN_COLOURS[domain.domain] ?? { bar: "bg-gray-400", text: "text-gray-600", bg: "bg-gray-50" };
  return (
    <div className={cn("flex items-center gap-2", compact ? "py-0.5" : "py-1")}>
      <span className={cn("shrink-0 font-medium", compact ? "text-[10px] w-20" : "text-[11px] w-24", colours.text)}>
        {domain.label}
      </span>
      <div className="flex-1 bg-gray-100 rounded-full h-1.5 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", colours.bar)}
          style={{ width: `${domain.score}%` }}
        />
      </div>
      <span className="text-[10px] text-gray-500 w-7 text-right shrink-0">{domain.score}%</span>
    </div>
  );
}

function CoveragePanel({ data }: { data: DomainCoverageReport }) {
  const [expandedManual, setExpandedManual] = useState<number | null>(null);
  const sorted = [...data.globalDomains].sort((a, b) => b.score - a.score);

  return (
    <div className="px-4 sm:px-5 py-4 space-y-4">
      {/* Global bars */}
      <div>
        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Knowledge Base — {data.totalManuals} manual{data.totalManuals !== 1 ? "s" : ""}
        </p>
        {sorted.map((d) => <DomainBar key={d.domain} domain={d} />)}
      </div>

      {/* Per-manual breakdown */}
      {data.manuals.length > 0 && (
        <div className="border-t border-gray-100 pt-3 space-y-1.5">
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Per manual</p>
          {data.manuals.map((m) => {
            const isOpen = expandedManual === m.manualId;
            const primary = DOMAIN_COLOURS[m.primaryDomain] ?? { bg: "bg-gray-50", text: "text-gray-600" };
            return (
              <div key={m.manualId} className="rounded-lg border border-gray-100 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpandedManual(isOpen ? null : m.manualId)}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 transition-colors text-left"
                >
                  <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0", primary.bg, primary.text)}>
                    {m.primaryDomain.replace(/_/g, " ").toUpperCase().slice(0, 5)}
                  </span>
                  <span className="text-xs font-medium text-gray-700 truncate flex-1">{m.manualName}</span>
                  <span className="text-[10px] text-gray-400 shrink-0">{m.totalChunks} chunks</span>
                  <ChevronDown className={cn("w-3 h-3 text-gray-400 shrink-0 transition-transform", isOpen && "rotate-180")} />
                </button>
                {isOpen && (
                  <div className="px-3 pb-2.5 border-t border-gray-100 pt-2 bg-gray-50/50 space-y-2.5">
                    {/* Domain score bars */}
                    <div>
                      {[...m.domains].sort((a, b) => b.score - a.score).map((d) => (
                        <DomainBar key={d.domain} domain={d} compact />
                      ))}
                      <p className="text-[10px] text-gray-400 mt-1">
                        {m.totalEntities} entities · {m.totalChunks} weighted chunks
                      </p>
                    </div>

                    {/* Section breakdown */}
                    {m.sections && m.sections.filter(s => s.name !== "Uncategorized").length > 0 && (
                      <div className="border-t border-gray-100 pt-2">
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
                          Sections
                        </p>
                        <div className="space-y-1">
                          {m.sections
                            .filter(s => s.name !== "Uncategorized")
                            .map((s) => {
                              const colours = DOMAIN_COLOURS[s.primaryDomain] ?? { bg: "bg-gray-100", text: "text-gray-500" };
                              return (
                                <div key={s.name} className="flex items-center gap-2 min-w-0">
                                  <span className={cn("shrink-0 text-[8px] font-bold px-1 py-0.5 rounded uppercase leading-none", colours.bg, colours.text)}>
                                    {s.label.slice(0, 5)}
                                  </span>
                                  <span className="text-[10px] text-gray-600 truncate flex-1 min-w-0">{s.name}</span>
                                  <span className="text-[10px] text-gray-400 shrink-0">{s.weightedChunks}</span>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[10px] text-gray-400">
        Scanned {new Date(data.scannedAt).toLocaleTimeString()}
      </p>
    </div>
  );
}
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

export default function Dashboard() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useGetGlobalStats();
  const { data: manuals, isLoading: manualsLoading, refetch: refetchManuals } = useListManuals({
    query: {
      queryKey: getListManualsQueryKey(),
      refetchInterval: (query) => {
        const data = query.state.data;
        return Array.isArray(data) && data.some((m) => m.status === "processing") ? 3000 : false;
      },
    },
  });
  const deleteManual = useDeleteManual();
  const [recentQs, setRecentQs] = useState<RecentQuestion[]>([]);
  const [weekCount, setWeekCount] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [newlyUploadedId, setNewlyUploadedId] = useState<number | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [coverageData, setCoverageData] = useState<DomainCoverageReport | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const uploadRef = useRef<UploadPDFRef>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newCardRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    setRecentQs(getRecentQuestions());
    setWeekCount(countQuestionsThisWeek());
  }, []);

  // Scroll the highlighted card into view once the list updates after upload
  useEffect(() => {
    if (newlyUploadedId !== null && newCardRef.current) {
      newCardRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [newlyUploadedId, manuals]);

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

  function handleUploaded(id: number) {
    setNewlyUploadedId(id);
    queryClient.invalidateQueries({ queryKey: getListManualsQueryKey() });
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    // Clear highlight after 4 s
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setNewlyUploadedId(null), 4000);
  }

  function handleStarted() {
    queryClient.invalidateQueries({ queryKey: getListManualsQueryKey() });
    refetchStats();
  }

  async function handleScanCoverage() {
    setCoverageLoading(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/manuals/domain-coverage", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error("Scan failed");
      const data: DomainCoverageReport = await res.json();
      setCoverageData(data);
    } catch {
      toast.error("Coverage scan failed");
    } finally {
      setCoverageLoading(false);
    }
  }

  // ── Drag-and-drop ─────────────────────────────────────────────────────────
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes("Files")) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    uploadRef.current?.uploadFile(file);
  }, []);

  const lastQ = recentQs[0];
  const pendingCount = manuals?.filter((m) => m.status === "pending" || m.status === "structure_complete").length ?? 0;
  const processingCount = manuals?.filter((m) => m.status === "processing").length ?? 0;

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

        {/* ── File Management ── */}
        <div className="lg:col-span-3 bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-3.5 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-gray-500" />
              <h2 className="text-sm font-semibold text-gray-700">Manage Files</h2>
              {processingCount > 0 && (
                <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 text-[10px] px-1.5 py-0 font-medium animate-pulse">
                  {processingCount} processing
                </Badge>
              )}
              {pendingCount > 0 && processingCount === 0 && (
                <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100 text-[10px] px-1.5 py-0 font-medium">
                  {pendingCount} ready to configure
                </Badge>
              )}
            </div>
            <UploadPDF ref={uploadRef} onUploaded={handleUploaded} />
          </div>

          {/* Drop zone wrapper */}
          <div
            className="relative p-4 sm:p-5 space-y-3"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {/* Drag overlay */}
            {isDragOver && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-b-lg border-2 border-dashed border-blue-400 bg-blue-50/90 pointer-events-none">
                <UploadCloud className="w-10 h-10 text-blue-500 mb-2" />
                <p className="text-sm font-semibold text-blue-700">Drop PDF here to upload</p>
              </div>
            )}

            {manualsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="rounded-lg border border-gray-100 p-3.5">
                    <div className="flex gap-2.5 items-start">
                      <Skeleton className="w-7 h-7 rounded" />
                      <div className="flex-1">
                        <Skeleton className="h-4 w-3/4 mb-1.5" />
                        <Skeleton className="h-3 w-1/2 mb-1" />
                        <Skeleton className="h-3 w-1/3" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : manuals?.length ? (
              <div className="space-y-3">
                {manuals.map((manual) => (
                  <div
                    key={manual.id}
                    ref={manual.id === newlyUploadedId ? newCardRef : undefined}
                  >
                    <FileCard
                      manual={manual}
                      onDelete={handleDelete}
                      onStarted={handleStarted}
                      getToken={getToken}
                      highlight={manual.id === newlyUploadedId}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mb-3">
                  <BookOpen className="w-6 h-6 text-gray-300" />
                </div>
                <p className="text-sm text-gray-500 font-medium">No documents uploaded yet</p>
                <p className="text-xs text-gray-400 mt-1">
                  Click <strong>Upload PDF</strong> above, or drag a file here.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ── Right column ── */}
        <div className="lg:col-span-2 space-y-4">

          {/* Global graph shortcut */}
          {(stats?.completedManuals ?? 0) > 0 && (
            <div className="bg-white rounded-lg border border-gray-200">
              <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-gray-100">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-purple-500" />
                  <h2 className="text-sm font-semibold text-gray-700">Knowledge Graph</h2>
                </div>
              </div>
              <div className="px-4 sm:px-5 py-4 space-y-2.5">
                <p className="text-xs text-gray-500">
                  Explore all extracted entities and relationships across your entire knowledge base.
                </p>
                <Link href="/graph">
                  <Button variant="outline" size="sm" className="w-full gap-1.5 text-xs text-gray-600 justify-between">
                    Open Global Graph
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Button>
                </Link>
                <Link href="/ask">
                  <Button variant="outline" size="sm" className="w-full gap-1.5 text-xs text-gray-600 justify-between">
                    Ask Engineer
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Button>
                </Link>
              </div>
            </div>
          )}

          {/* Coverage Analysis */}
          {(stats?.completedManuals ?? 0) > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-gray-100">
                <div className="flex items-center gap-2">
                  <BarChart2 className="w-4 h-4 text-gray-500" />
                  <h2 className="text-sm font-semibold text-gray-700">Coverage Analysis</h2>
                  {coverageData && (
                    <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 text-[10px] px-1.5 py-0 font-medium">
                      {coverageData.totalManuals} scanned
                    </Badge>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-gray-600 text-xs h-7"
                  onClick={handleScanCoverage}
                  disabled={coverageLoading}
                >
                  {coverageLoading
                    ? <><Loader2 className="w-3 h-3 animate-spin" />Scanning…</>
                    : <><ScanLine className="w-3 h-3" />{coverageData ? "Re-scan" : "Scan"}</>
                  }
                </Button>
              </div>
              {!coverageData && !coverageLoading && (
                <div className="px-4 sm:px-5 py-5 text-center">
                  <p className="text-xs text-gray-500">
                    Analyse which technical domains your uploaded manuals cover — electrical, hydraulic, mechanical, and more.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 gap-1.5 text-xs text-gray-600"
                    onClick={handleScanCoverage}
                  >
                    <ScanLine className="w-3.5 h-3.5" />
                    Scan now
                  </Button>
                </div>
              )}
              {coverageLoading && (
                <div className="px-4 sm:px-5 py-5 flex items-center justify-center gap-2 text-xs text-gray-400">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Analysing content patterns…
                </div>
              )}
              {coverageData && !coverageLoading && (
                <CoveragePanel data={coverageData} />
              )}
            </div>
          )}

          {/* Recent Questions */}
          <div className="bg-white rounded-lg border border-gray-200">
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
    </div>
  );
}
