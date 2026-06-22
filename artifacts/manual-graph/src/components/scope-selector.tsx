import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, BookOpen, AlignJustify, FileText, Play, RefreshCw, Info } from "lucide-react";

type ScopeMode = "whole" | "range" | "single";

interface CostEstimate {
  estimatedCostUsd: number;
  modelLabel: string;
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  isActual: boolean;
  disclaimer: string;
}

interface ScopeSelectorProps {
  manualId: number;
  totalPages: number;
  getToken: () => Promise<string | null>;
  onStarted: () => void;
  compact?: boolean;
}

export function ScopeSelector({ manualId, totalPages, getToken, onStarted, compact = false }: ScopeSelectorProps) {
  const [mode, setMode] = useState<ScopeMode>("whole");
  const [singlePage, setSinglePage] = useState(1);
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(totalPages || 1);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState("");
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  const [costLoading, setCostLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (totalPages > 0 && rangeEnd === 1) setRangeEnd(totalPages);
  }, [totalPages, rangeEnd]);

  const fetchCost = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setCostLoading(true);
    try {
      const token = await getToken();
      const params = new URLSearchParams();
      if (mode === "single") {
        params.set("startPage", String(singlePage));
        params.set("endPage", String(singlePage));
      } else if (mode === "range") {
        params.set("startPage", String(rangeStart));
        params.set("endPage", String(rangeEnd));
      }
      const res = await fetch(`/api/manuals/${manualId}/cost-estimate?${params.toString()}`, {
        signal: ctrl.signal,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) setCostEstimate(await res.json());
    } catch {
      // abort or network error — silently ignore
    } finally {
      setCostLoading(false);
    }
  }, [manualId, mode, singlePage, rangeStart, rangeEnd, getToken]);

  useEffect(() => {
    const timer = setTimeout(fetchCost, 350);
    return () => clearTimeout(timer);
  }, [fetchCost]);

  function pageCount(): number {
    if (mode === "whole") return totalPages;
    if (mode === "single") return 1;
    return Math.max(1, rangeEnd - rangeStart + 1);
  }

  async function handleStart() {
    setIsStarting(true);
    setError("");
    try {
      const token = await getToken();
      const body: Record<string, number> = {};
      if (mode === "single") {
        body.startPage = singlePage;
        body.endPage = singlePage;
      } else if (mode === "range") {
        body.startPage = rangeStart;
        body.endPage = rangeEnd;
      }
      const res = await fetch(`/api/manuals/${manualId}/process`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start processing");
      setIsStarting(false);
    }
  }

  const scopeOptions: { id: ScopeMode; label: string; icon: React.ReactNode; tagline: string }[] = [
    { id: "whole",  label: "Whole document", icon: <BookOpen className={compact ? "w-3.5 h-3.5" : "w-4 h-4"} />,     tagline: "All pages" },
    { id: "range",  label: "Page range",     icon: <AlignJustify className={compact ? "w-3.5 h-3.5" : "w-4 h-4"} />, tagline: "From … to …" },
    { id: "single", label: "Single page",    icon: <FileText className={compact ? "w-3.5 h-3.5" : "w-4 h-4"} />,     tagline: "One page" },
  ];

  const inputCls = "w-20 rounded border border-gray-200 bg-white px-2 py-1 text-xs font-mono text-center text-gray-900 focus:outline-none focus:ring-1 focus:ring-slate-400";

  const tooltipText = costEstimate
    ? `Model: ${costEstimate.modelLabel}\nInput: $${costEstimate.inputPer1MUsd.toFixed(2)}/1M tokens · Output: $${costEstimate.outputPer1MUsd.toFixed(2)}/1M tokens\n\n${costEstimate.disclaimer}`
    : "";

  const costRow = (
    <div className="flex items-center gap-1 text-[11px] text-gray-400 min-h-[16px]">
      {costLoading && !costEstimate && (
        <span className="animate-pulse">Estimating cost…</span>
      )}
      {costEstimate && (
        <>
          <span>
            {costEstimate.isActual ? "Est. cost:" : "~"}<span className="font-mono font-medium text-gray-500 ml-0.5">${costEstimate.estimatedCostUsd.toFixed(2)}</span>
            {!costEstimate.isActual && " estimated"}
          </span>
          <span title={tooltipText} className="cursor-help text-gray-300 hover:text-gray-500 transition-colors">
            <Info className="w-3 h-3" />
          </span>
        </>
      )}
    </div>
  );

  if (compact) {
    return (
      <div className="space-y-3 pt-1">
        <p className="text-xs font-medium text-gray-500">Choose pages to process</p>

        {/* Pills */}
        <div className="flex gap-1.5">
          {scopeOptions.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setMode(opt.id)}
              className={[
                "flex-1 flex flex-col items-center gap-1 rounded-lg border py-2 px-1 text-[11px] font-medium transition-all",
                mode === opt.id
                  ? "border-slate-700 bg-slate-800 text-white shadow-sm"
                  : "border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-400 hover:text-gray-700",
              ].join(" ")}
            >
              {opt.icon}
              <span className="leading-none">{opt.label}</span>
            </button>
          ))}
        </div>

        {/* Inputs */}
        {mode === "single" && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 shrink-0">Page</label>
            <input
              type="number"
              min={1}
              max={totalPages || undefined}
              value={singlePage}
              onChange={(e) => setSinglePage(Math.max(1, parseInt(e.target.value) || 1))}
              className={inputCls}
            />
            {totalPages > 0 && <span className="text-xs text-gray-400">of {totalPages}</span>}
          </div>
        )}

        {mode === "range" && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 w-10 shrink-0">From</label>
              <input
                type="number"
                min={1}
                max={totalPages || undefined}
                value={rangeStart}
                onChange={(e) => setRangeStart(Math.max(1, parseInt(e.target.value) || 1))}
                className={inputCls}
              />
              <label className="text-xs text-gray-500 w-4 shrink-0 text-center">–</label>
              <input
                type="number"
                min={rangeStart}
                max={totalPages || undefined}
                value={rangeEnd}
                onChange={(e) => setRangeEnd(Math.max(rangeStart, parseInt(e.target.value) || rangeStart))}
                className={inputCls}
              />
              <span className="text-xs text-gray-400">{pageCount()} pages</span>
            </div>
            {totalPages > 0 && (
              <button
                onClick={() => { setRangeStart(1); setRangeEnd(totalPages); }}
                className="text-[11px] text-blue-600 hover:text-blue-800 underline underline-offset-2"
              >
                Select all {totalPages}
              </button>
            )}
          </div>
        )}

        {mode === "whole" && totalPages > 0 && (
          <p className="text-xs text-gray-500">
            All <span className="font-semibold text-gray-700">{totalPages}</span> pages will be processed.
          </p>
        )}

        {costRow}

        {error && (
          <div className="flex items-center gap-1.5 text-red-600 text-xs bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            {error}
          </div>
        )}

        <button
          onClick={handleStart}
          disabled={isStarting}
          className="w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs transition-all shadow disabled:opacity-50"
        >
          {isStarting
            ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" />Starting…</>
            : <><Play className="w-3.5 h-3.5" />Start Processing</>}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center w-full text-center space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-foreground">Choose what to process</h3>
        <p className="text-sm text-muted-foreground mt-1">
          All extraction passes will run automatically on the pages you select.
        </p>
      </div>

      <div className="flex gap-2 w-full">
        {scopeOptions.map((opt) => (
          <button
            key={opt.id}
            onClick={() => setMode(opt.id)}
            className={[
              "flex-1 flex flex-col items-center gap-1.5 rounded-xl border-2 py-3 px-2 text-xs font-medium transition-all",
              mode === opt.id
                ? "border-slate-800 bg-slate-800 text-white shadow-md"
                : "border-border bg-card text-muted-foreground hover:border-slate-400 hover:text-foreground",
            ].join(" ")}
          >
            {opt.icon}
            <span className="font-semibold">{opt.label}</span>
            <span className={mode === opt.id ? "text-white/60" : "text-muted-foreground/70"}>{opt.tagline}</span>
          </button>
        ))}
      </div>

      {mode === "single" && (
        <div className="w-full space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground text-left block">Page number</label>
          <input
            type="number"
            min={1}
            max={totalPages || undefined}
            value={singlePage}
            onChange={(e) => setSinglePage(Math.max(1, parseInt(e.target.value) || 1))}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-center text-gray-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
          {totalPages > 0 && (
            <p className="text-xs text-muted-foreground">Document has {totalPages} pages</p>
          )}
        </div>
      )}

      {mode === "range" && (
        <div className="w-full space-y-3">
          <div className="flex gap-3 items-end">
            <div className="flex-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground block text-left">From page</label>
              <input
                type="number"
                min={1}
                max={totalPages || undefined}
                value={rangeStart}
                onChange={(e) => setRangeStart(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-center text-gray-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
            <span className="text-muted-foreground pb-2">–</span>
            <div className="flex-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground block text-left">To page</label>
              <input
                type="number"
                min={rangeStart}
                max={totalPages || undefined}
                value={rangeEnd}
                onChange={(e) => setRangeEnd(Math.max(rangeStart, parseInt(e.target.value) || rangeStart))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-center text-gray-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs text-muted-foreground">{pageCount()} pages selected</span>
            {totalPages > 0 && (
              <button
                onClick={() => { setRangeStart(1); setRangeEnd(totalPages); }}
                className="text-xs text-blue-600 hover:text-blue-800 underline underline-offset-2"
              >
                Select all {totalPages}
              </button>
            )}
          </div>
        </div>
      )}

      {mode === "whole" && totalPages > 0 && (
        <p className="text-sm text-muted-foreground">
          Processing all <span className="font-semibold text-foreground">{totalPages}</span> pages.
        </p>
      )}

      <div className="w-full text-left">{costRow}</div>

      {error && (
        <div className="flex items-center gap-2 text-red-600 text-xs bg-red-50 border border-red-200 rounded-lg px-3 py-2 w-full text-left">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {error}
        </div>
      )}

      <button
        onClick={handleStart}
        disabled={isStarting}
        className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-semibold text-sm transition-all shadow disabled:opacity-50"
      >
        {isStarting
          ? <><RefreshCw className="w-4 h-4 animate-spin" />Starting…</>
          : <><Play className="w-4 h-4" />Start Processing</>}
      </button>
    </div>
  );
}
