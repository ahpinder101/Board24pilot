import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot, User, Send, BookOpen, Loader2, MessageSquare, ExternalLink,
  FileText, Paperclip, X, Image, Globe, ThumbsUp, ThumbsDown,
  ChevronDown, ChevronRight, Zap, Shield, FlaskConical, CheckCircle2,
  AlertTriangle, XCircle, Database, GitBranch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { saveRecentQuestion } from "@/hooks/use-recent-questions";

// ── Languages ────────────────────────────────────────────────────────────────

const LANGUAGES = [
  { code: "en", label: "English",  native: "English" },
  { code: "pl", label: "Polish",   native: "Polski"  },
  { code: "es", label: "Spanish",  native: "Español" },
  { code: "fr", label: "French",   native: "Français"},
  { code: "de", label: "German",   native: "Deutsch" },
  { code: "zh", label: "Chinese",  native: "中文"     },
] as const;

type LangCode = (typeof LANGUAGES)[number]["code"];

interface TranslationState {
  lang: LangCode;
  text: string | null;
  loading: boolean;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Citation {
  manualId: number;
  manualName: string;
  pageNumber?: number;
  excerpt: string;
  entityNames?: string[];
  citationQuality?: "strong" | "partial" | "weak" | "unverified";
}

type ConfidenceLevel = "high" | "medium" | "low" | "unverified";
type AnswerabilityStatus = "answerable" | "partially_answerable" | "not_answerable";

interface EvidenceSummary {
  chunksFound: number;
  entitiesFound: number;
  pathsFound: number;
  hasGraphContext: boolean;
  manualsSearched: string[];
}

interface ValidationSummary {
  status: "pass" | "revise" | "fail";
  presentItems: string[];
  missingItems: string[];
  weakItems: string[];
  unsupportedClaims: string[];
  suggestedGuidance: string[];
  citationIssues: string[];
  sequenceIssues: string[];
}

interface MissingOrWeakEvidenceItem {
  claimOrQuestionPart: string;
  issue: "missing" | "weak" | "conflicting";
  explanation?: string;
}

interface ValidationMetadata {
  validationPassCount: number;
  revisedOnce: boolean;
  finalValidationStatus: "passed" | "passed_with_warnings" | "failed";
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  imageDataUrl?: string;
  citations?: Citation[];
  pending?: boolean;
  confidence?: ConfidenceLevel;
  answerability?: AnswerabilityStatus;
  domain?: string;
  isGuided?: boolean;
  evidenceSummary?: EvidenceSummary;
  validationSummary?: ValidationSummary;
  missingOrWeakEvidence?: MissingOrWeakEvidenceItem[];
  validationMetadata?: ValidationMetadata;
}

interface FeedbackState {
  rating: "positive" | "negative";
  submitted: boolean;
}

// ── ConfidenceBadge ───────────────────────────────────────────────────────────

const CONFIDENCE_CONFIG: Record<ConfidenceLevel, { label: string; className: string; icon: React.ReactNode }> = {
  high: {
    label: "High confidence",
    className: "bg-green-50 text-green-700 border-green-200",
    icon: <CheckCircle2 className="w-3 h-3" />,
  },
  medium: {
    label: "Medium confidence",
    className: "bg-yellow-50 text-yellow-700 border-yellow-200",
    icon: <AlertTriangle className="w-3 h-3" />,
  },
  low: {
    label: "Low confidence",
    className: "bg-orange-50 text-orange-700 border-orange-200",
    icon: <AlertTriangle className="w-3 h-3" />,
  },
  unverified: {
    label: "Unverified",
    className: "bg-gray-50 text-gray-500 border-gray-200",
    icon: <XCircle className="w-3 h-3" />,
  },
};

function ConfidenceBadge({ level }: { level: ConfidenceLevel }) {
  const cfg = CONFIDENCE_CONFIG[level];
  return (
    <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border", cfg.className)}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

const DOMAIN_LABELS: Record<string, string> = {
  electrical_control: "Electrical",
  hydraulic_schematic: "Hydraulic",
  pneumatic_schematic: "Pneumatic",
  mechanical_assembly: "Mechanical",
  troubleshooting: "Troubleshooting",
  generic_process: "General",
};

// ── EvidencePanel ─────────────────────────────────────────────────────────────

function EvidencePanel({ evidence, open, onToggle }: {
  evidence: EvidenceSummary;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 text-xs overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-gray-600 hover:bg-gray-100 transition-colors"
      >
        <span className="flex items-center gap-1.5 font-medium">
          <Database className="w-3.5 h-3.5 text-gray-400" />
          Evidence retrieved
        </span>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-1.5 border-t border-gray-200 pt-2">
          <div className="flex items-center gap-2 text-gray-500">
            <span className="font-medium text-gray-700">{evidence.chunksFound}</span> text chunk{evidence.chunksFound !== 1 ? "s" : ""}
            {evidence.manualsSearched.length > 0 && (
              <span>from <span className="font-medium text-gray-700">{evidence.manualsSearched.join(", ")}</span></span>
            )}
          </div>
          {evidence.entitiesFound > 0 && (
            <div className="text-gray-500">
              <span className="font-medium text-gray-700">{evidence.entitiesFound}</span> entity/relationship record{evidence.entitiesFound !== 1 ? "s" : ""}
            </div>
          )}
          {evidence.pathsFound > 0 && (
            <div className="flex items-center gap-1.5 text-gray-500">
              <GitBranch className="w-3 h-3" />
              <span className="font-medium text-gray-700">{evidence.pathsFound}</span> procedural path{evidence.pathsFound !== 1 ? "s" : ""}
            </div>
          )}
          {evidence.chunksFound === 0 && evidence.entitiesFound === 0 && (
            <div className="text-gray-400 italic">No relevant evidence found in the manuals.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── ValidationPanel ───────────────────────────────────────────────────────────

function ValidationPanel({ validation, validationMetadata, open, onToggle }: {
  validation: ValidationSummary;
  validationMetadata?: ValidationMetadata;
  open: boolean;
  onToggle: () => void;
}) {
  const statusIcon =
    validation.status === "pass" ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> :
    validation.status === "revise" ? <AlertTriangle className="w-3.5 h-3.5 text-yellow-500" /> :
    <XCircle className="w-3.5 h-3.5 text-red-500" />;

  const statusLabel =
    validation.status === "pass" ? "Validation passed" :
    validation.status === "revise" ? "Answer revised by specialist" :
    "Evidence not found";

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 text-xs overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-gray-600 hover:bg-gray-100 transition-colors"
      >
        <span className="flex items-center gap-1.5 font-medium">
          {statusIcon}
          {statusLabel}
        </span>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-gray-200 pt-2 space-y-2">
          {validation.presentItems.length > 0 && (
            <div>
              <p className="font-medium text-green-700 mb-1">Covered:</p>
              {validation.presentItems.map((item, i) => (
                <div key={i} className="flex items-start gap-1 text-gray-600">
                  <CheckCircle2 className="w-3 h-3 text-green-500 mt-0.5 shrink-0" />
                  {item}
                </div>
              ))}
            </div>
          )}
          {validation.missingItems.length > 0 && (
            <div>
              <p className="font-medium text-orange-700 mb-1">Missing:</p>
              {validation.missingItems.map((item, i) => (
                <div key={i} className="flex items-start gap-1 text-gray-600">
                  <XCircle className="w-3 h-3 text-orange-400 mt-0.5 shrink-0" />
                  {item}
                </div>
              ))}
            </div>
          )}
          {validation.unsupportedClaims.length > 0 && (
            <div>
              <p className="font-medium text-red-700 mb-1">Unsupported claims:</p>
              {validation.unsupportedClaims.map((item, i) => (
                <div key={i} className="flex items-start gap-1 text-gray-600">
                  <AlertTriangle className="w-3 h-3 text-red-400 mt-0.5 shrink-0" />
                  {item}
                </div>
              ))}
            </div>
          )}
          {validation.citationIssues?.length > 0 && (
            <div>
              <p className="font-medium text-yellow-700 mb-1">Citation issues:</p>
              {validation.citationIssues.map((item, i) => (
                <div key={i} className="flex items-start gap-1 text-gray-600">
                  <AlertTriangle className="w-3 h-3 text-yellow-500 mt-0.5 shrink-0" />
                  {item}
                </div>
              ))}
            </div>
          )}
          {validation.sequenceIssues?.length > 0 && (
            <div>
              <p className="font-medium text-yellow-700 mb-1">Sequence issues:</p>
              {validation.sequenceIssues.map((item, i) => (
                <div key={i} className="flex items-start gap-1 text-gray-600">
                  <AlertTriangle className="w-3 h-3 text-yellow-500 mt-0.5 shrink-0" />
                  {item}
                </div>
              ))}
            </div>
          )}
          {validation.suggestedGuidance.length > 0 && (
            <div>
              <p className="font-medium text-blue-700 mb-1">Suggestions:</p>
              {validation.suggestedGuidance.map((item, i) => (
                <div key={i} className="text-gray-600 pl-3 border-l-2 border-blue-200">{item}</div>
              ))}
            </div>
          )}
          {validationMetadata && (
            <div className="pt-1 mt-1 border-t border-gray-200 flex items-center gap-3 text-gray-400">
              <span>Passes: <span className="font-medium text-gray-600">{validationMetadata.validationPassCount}</span></span>
              {validationMetadata.revisedOnce && <span className="text-yellow-600">· Revised once</span>}
              <span className={cn(
                "ml-auto font-medium",
                validationMetadata.finalValidationStatus === "passed" ? "text-green-600" :
                validationMetadata.finalValidationStatus === "passed_with_warnings" ? "text-yellow-600" :
                "text-red-600"
              )}>
                {validationMetadata.finalValidationStatus === "passed" ? "✓ Passed" :
                 validationMetadata.finalValidationStatus === "passed_with_warnings" ? "⚠ With warnings" :
                 "✗ Failed"}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── CitationChip ──────────────────────────────────────────────────────────────

function CitationChip({ citation, index }: { citation: Citation; index: number }) {
  const [fetching, setFetching] = useState(false);

  const shortName =
    citation.manualName.length > 28
      ? citation.manualName.slice(0, 28) + "…"
      : citation.manualName;

  async function openPdf() {
    if (fetching) return;
    setFetching(true);
    try {
      const res = await fetch(`/api/manuals/${citation.manualId}/pdf`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const target = citation.pageNumber ? `${blobUrl}#page=${citation.pageNumber}` : blobUrl;
      window.open(target, "_blank", "noopener,noreferrer");
      // Keep the blob URL alive for 2 minutes so the new tab can fully load
      setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);
    } catch {
      // Fallback: open the URL directly and let the browser handle auth
      const fallback = citation.pageNumber
        ? `/api/manuals/${citation.manualId}/pdf#page=${citation.pageNumber}`
        : `/api/manuals/${citation.manualId}/pdf`;
      window.open(fallback, "_blank", "noopener,noreferrer");
    } finally {
      setFetching(false);
    }
  }

  const qualityConfig = {
    strong: { dot: "bg-green-500", label: "Direct match" },
    partial: { dot: "bg-yellow-400", label: "Related" },
    weak: { dot: "bg-gray-300", label: "Keyword" },
    unverified: { dot: "bg-gray-200", label: null },
  };
  const quality = citation.citationQuality ? qualityConfig[citation.citationQuality] : null;

  return (
    <button
      type="button"
      onClick={openPdf}
      disabled={fetching}
      title={`${citation.manualName}${citation.pageNumber ? ` · page ${citation.pageNumber}` : ""}\n\n${citation.excerpt}`}
      className="group flex items-start gap-2 px-3 py-2 rounded-lg border border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50 transition-colors text-left disabled:opacity-60 disabled:cursor-wait w-full"
    >
      <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
        <span className="text-[10px] font-bold text-gray-400 w-4 text-center">{index + 1}</span>
        {fetching
          ? <Loader2 className="w-3.5 h-3.5 text-blue-400 shrink-0 animate-spin" />
          : <FileText className="w-3.5 h-3.5 text-blue-400 shrink-0" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-medium text-gray-700 group-hover:text-blue-700 truncate">{shortName}</span>
          {citation.pageNumber && (
            <span className="text-[10px] font-mono bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded shrink-0">
              p.{citation.pageNumber}
            </span>
          )}
          {quality && (
            <span className="flex items-center gap-1 shrink-0">
              <span className={cn("w-1.5 h-1.5 rounded-full", quality.dot)} />
              {quality.label && (
                <span className="text-[9px] text-gray-400">{quality.label}</span>
              )}
            </span>
          )}
          <ExternalLink className="w-2.5 h-2.5 text-gray-300 group-hover:text-blue-400 shrink-0 ml-auto" />
        </div>
        <p className="text-[11px] text-gray-400 mt-0.5 line-clamp-2 leading-relaxed">{citation.excerpt}</p>
      </div>
    </button>
  );
}

// ── TranslateBar ──────────────────────────────────────────────────────────────

function TranslateBar({
  messageId,
  originalText,
  translation,
  onChange,
}: {
  messageId: string;
  originalText: string;
  translation: TranslationState | undefined;
  onChange: (msgId: string, lang: LangCode, originalText: string) => void;
}) {
  const current = translation?.lang ?? "en";

  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-gray-200 bg-gray-50 hover:border-blue-300 hover:bg-blue-50 transition-colors">
        <Globe className="w-4 h-4 text-gray-500 shrink-0" />
        <span className="text-xs text-gray-500 font-medium whitespace-nowrap">Translate:</span>
        <select
          value={current}
          onChange={(e) => onChange(messageId, e.target.value as LangCode, originalText)}
          className="text-sm font-semibold text-gray-700 bg-transparent border-none outline-none cursor-pointer hover:text-blue-600 transition-colors"
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.native}
            </option>
          ))}
        </select>
      </div>
      {translation?.loading && (
        <div className="flex items-center gap-1.5 text-xs text-blue-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>Translating…</span>
        </div>
      )}
    </div>
  );
}

// ── FeedbackBar ───────────────────────────────────────────────────────────────

function FeedbackBar({
  state,
  onThumbsUp,
  onThumbsDown,
}: {
  state: FeedbackState | undefined;
  onThumbsUp: () => void;
  onThumbsDown: () => void;
}) {
  const submitted = state?.submitted ?? false;
  const rating = state?.rating;

  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-gray-200 bg-gray-50">
        <span className="text-xs text-gray-500 font-medium">Helpful?</span>
        <button
          onClick={onThumbsUp}
          disabled={submitted}
          title="Good answer"
          className={cn(
            "p-1 rounded-md transition-colors",
            submitted && rating === "positive"
              ? "bg-green-100 text-green-600"
              : submitted
                ? "text-gray-300 cursor-default"
                : "text-gray-400 hover:bg-green-50 hover:text-green-600 cursor-pointer"
          )}
        >
          <ThumbsUp className="w-4 h-4" />
        </button>
        <button
          onClick={onThumbsDown}
          disabled={submitted}
          title="Report an issue or correct this answer"
          className={cn(
            "p-1 rounded-md transition-colors",
            submitted && rating === "negative"
              ? "bg-red-100 text-red-600"
              : submitted
                ? "text-gray-300 cursor-default"
                : "text-gray-400 hover:bg-red-50 hover:text-red-600 cursor-pointer"
          )}
        >
          <ThumbsDown className="w-4 h-4" />
        </button>
        {submitted && (
          <span className="text-xs text-gray-400 italic">
            {rating === "positive" ? "Thanks!" : "Feedback noted"}
          </span>
        )}
      </div>
    </div>
  );
}

// ── FeedbackDialog ────────────────────────────────────────────────────────────

function FeedbackDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (reason: string, correction: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [correction, setCorrection] = useState("");

  useEffect(() => {
    if (open) {
      setReason("");
      setCorrection("");
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-2xl border border-gray-200 p-5 w-full max-w-lg space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-gray-900 text-base">Report an issue</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Corrections you provide are used to improve future answers.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 shrink-0 mt-0.5"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Reason */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-gray-600">What was wrong? (optional)</label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-gray-700 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition"
          >
            <option value="">Choose a reason…</option>
            <option value="Wrong information">Wrong information</option>
            <option value="Incomplete answer">Incomplete answer</option>
            <option value="Not relevant">Not relevant to my question</option>
            <option value="Unclear explanation">Unclear explanation</option>
            <option value="Other">Other</option>
          </select>
        </div>

        {/* Correction */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-gray-600">
            Correct answer or missing information
            <span className="text-gray-400 font-normal ml-1">(optional)</span>
          </label>
          <p className="text-[11px] text-gray-400">
            This is fed directly into the knowledge base so future questions on this topic get better answers.
          </p>
          <Textarea
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            placeholder="e.g. The correct torque is 45 Nm, not 30 Nm. The oil capacity is 2.5L for the WM-12 model…"
            className="resize-none text-sm min-h-[110px] bg-gray-50 border-gray-200 rounded-xl text-gray-800 placeholder:text-gray-400 focus:border-blue-300"
            rows={4}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} className="text-gray-600">
            Cancel
          </Button>
          <Button
            onClick={() => { onSubmit(reason, correction); onClose(); }}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            Submit feedback
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AskPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [translations, setTranslations] = useState<Record<string, TranslationState>>({});
  const [feedbackStates, setFeedbackStates] = useState<Record<string, FeedbackState>>({});
  const [feedbackDialog, setFeedbackDialog] = useState<{
    messageId: string;
    question: string;
    answer: string;
    sessionId: string;
  } | null>(null);
  const [input, setInput] = useState("");
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [agentMode, setAgentMode] = useState(true);
  const [domain, setDomain] = useState("auto");
  const [strictness, setStrictness] = useState<"normal" | "engineering_strict" | "safety_critical">("normal");
  const [retrievalMode, setRetrievalMode] = useState<"fact_lookup" | "process_trace" | "troubleshooting_flow" | "relationship_trace">("fact_lookup");
  const [expandedPanels, setExpandedPanels] = useState<Record<string, { evidence?: boolean; validation?: boolean }>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const togglePanel = (msgId: string, panel: "evidence" | "validation") => {
    setExpandedPanels((prev) => ({
      ...prev,
      [msgId]: { ...prev[msgId], [panel]: !(prev[msgId]?.[panel] ?? false) },
    }));
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Translation ─────────────────────────────────────────────────────────────

  const handleTranslate = async (msgId: string, lang: LangCode, originalText: string) => {
    if (lang === "en") {
      setTranslations((prev) => {
        const next = { ...prev };
        delete next[msgId];
        return next;
      });
      return;
    }

    const langLabel = LANGUAGES.find((l) => l.code === lang)?.label ?? lang;
    setTranslations((prev) => ({ ...prev, [msgId]: { lang, text: null, loading: true } }));

    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: originalText, targetLanguage: langLabel }),
      });
      if (!res.ok) throw new Error("Translation request failed");
      const data = await res.json() as { translatedText: string };
      setTranslations((prev) => ({ ...prev, [msgId]: { lang, text: data.translatedText, loading: false } }));
    } catch {
      setTranslations((prev) => ({ ...prev, [msgId]: { lang, text: null, loading: false } }));
    }
  };

  // ── Feedback ────────────────────────────────────────────────────────────────

  const submitFeedback = async (
    messageId: string,
    question: string,
    answer: string,
    sid: string,
    rating: "positive" | "negative",
    reason: string,
    correction: string,
  ) => {
    setFeedbackStates((prev) => ({ ...prev, [messageId]: { rating, submitted: true } }));
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, question, answer, rating, reason: reason || undefined, correction: correction || undefined }),
      });
    } catch {
      // silent — feedback is best-effort
    }
  };

  const handleThumbsUp = (msg: Message, question: string) => {
    if (feedbackStates[msg.id]?.submitted) return;
    void submitFeedback(msg.id, question, msg.content, sessionId ?? "", "positive", "", "");
  };

  const handleThumbsDown = (msg: Message, question: string) => {
    if (feedbackStates[msg.id]?.submitted) return;
    setFeedbackDialog({ messageId: msg.id, question, answer: msg.content, sessionId: sessionId ?? "" });
  };

  const handleFeedbackDialogSubmit = (reason: string, correction: string) => {
    if (!feedbackDialog) return;
    void submitFeedback(
      feedbackDialog.messageId,
      feedbackDialog.question,
      feedbackDialog.answer,
      feedbackDialog.sessionId,
      "negative",
      reason,
      correction,
    );
  };

  // ── Image attachment ────────────────────────────────────────────────────────

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setAttachedImage(ev.target?.result as string);
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  // ── Send message ────────────────────────────────────────────────────────────

  const canSend = (input.trim().length > 0 || attachedImage !== null) && !isLoading;

  const handleSend = async () => {
    const question = input.trim() || "What can you tell me about this?";
    if (!canSend) return;

    saveRecentQuestion(question);
    const imageSnapshot = attachedImage;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: input.trim(),
      imageDataUrl: imageSnapshot ?? undefined,
    };
    const pendingMsg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      pending: true,
    };

    setMessages((prev) => [...prev, userMsg, pendingMsg]);
    setInput("");
    setAttachedImage(null);
    setIsLoading(true);

    try {
      const endpoint = agentMode ? "/api/chat/agent" : "/api/chat";
      const body: Record<string, unknown> = { question, sessionId };
      if (imageSnapshot) body.imageDataUrl = imageSnapshot;
      if (agentMode) {
        body.domain = domain;
        body.strictness = strictness;
        body.retrievalMode = retrievalMode;
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("Request failed");

      const data = await res.json() as {
        answer: string;
        citations: Citation[];
        sessionId: string;
        confidence?: ConfidenceLevel;
        answerability?: AnswerabilityStatus;
        domain?: string;
        isGuided?: boolean;
        evidenceSummary?: EvidenceSummary;
        validationSummary?: ValidationSummary;
        missingOrWeakEvidence?: MissingOrWeakEvidenceItem[];
        validationMetadata?: ValidationMetadata;
      };

      setSessionId(data.sessionId);
      setMessages((prev) =>
        prev.map((m) =>
          m.pending
            ? {
                ...m,
                content: data.answer,
                citations: data.citations,
                pending: false,
                confidence: data.confidence,
                answerability: data.answerability,
                domain: data.domain,
                isGuided: data.isGuided,
                evidenceSummary: data.evidenceSummary,
                validationSummary: data.validationSummary,
                missingOrWeakEvidence: data.missingOrWeakEvidence,
                validationMetadata: data.validationMetadata,
              }
            : m
        )
      );
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.pending
            ? { ...m, content: "Failed to get a response. Please try again.", pending: false }
            : m
        )
      );
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <FeedbackDialog
        open={feedbackDialog !== null}
        onClose={() => setFeedbackDialog(null)}
        onSubmit={handleFeedbackDialogSubmit}
      />

      <div className="h-full flex flex-col max-w-4xl mx-auto w-full px-3 sm:px-6 py-4 sm:py-6">
        {/* Header */}
        <div className="mb-4 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-lg sm:text-xl font-bold text-gray-900">Ask Engineer</h1>
              <p className="text-xs sm:text-sm text-gray-500 mt-0.5 hidden sm:block">
                Ask anything about your uploaded manuals — or attach a photo of a part and ask about it.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAgentMode((v) => !v)}
              title={agentMode ? "Enhanced Analysis on — click to use standard mode" : "Enable Enhanced Analysis (Domain Specialist + confidence scoring)"}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors shrink-0",
                agentMode
                  ? "bg-violet-600 text-white border-violet-700 hover:bg-violet-700"
                  : "bg-white text-gray-500 border-gray-200 hover:border-violet-300 hover:text-violet-600"
              )}
            >
              <Zap className="w-3.5 h-3.5" />
              {agentMode ? "Enhanced" : "Enhanced"}
            </button>
          </div>

          {/* Agent settings row — only shown when enhanced mode is on */}
          {agentMode && (
            <div className="mt-2 flex flex-wrap items-center gap-2 p-2.5 rounded-lg bg-violet-50 border border-violet-100">
              <FlaskConical className="w-3.5 h-3.5 text-violet-500 shrink-0" />
              <span className="text-[11px] font-medium text-violet-600 shrink-0">Enhanced Analysis</span>

              <div className="flex items-center gap-1.5 ml-auto">
                <label className="text-[11px] text-gray-500">Domain:</label>
                <select
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className="text-[11px] border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-700"
                >
                  <option value="auto">Auto-detect</option>
                  <option value="electrical_control">Electrical</option>
                  <option value="hydraulic_schematic">Hydraulic</option>
                  <option value="pneumatic_schematic">Pneumatic</option>
                  <option value="mechanical_assembly">Mechanical</option>
                  <option value="troubleshooting">Troubleshooting</option>
                  <option value="generic_process">General</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <label className="text-[11px] text-gray-500">Strictness:</label>
                <select
                  value={strictness}
                  onChange={(e) => setStrictness(e.target.value as typeof strictness)}
                  className="text-[11px] border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-700"
                >
                  <option value="normal">Normal</option>
                  <option value="engineering_strict">Engineering Strict</option>
                  <option value="safety_critical">Safety Critical</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <label className="text-[11px] text-gray-500">Mode:</label>
                <select
                  value={retrievalMode}
                  onChange={(e) => setRetrievalMode(e.target.value as typeof retrievalMode)}
                  className="text-[11px] border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-700"
                >
                  <option value="fact_lookup">Fact lookup</option>
                  <option value="process_trace">Process trace</option>
                  <option value="troubleshooting_flow">Troubleshooting</option>
                  <option value="relationship_trace">Relationship trace</option>
                </select>
              </div>

              <span title="Domain Specialist validates the answer before it reaches you" className="ml-1 text-[10px] text-violet-400 hidden sm:inline">
                <Shield className="w-3 h-3 inline mr-0.5" />GPT-4o validates
              </span>
            </div>
          )}
        </div>

        {/* Chat container */}
        <div className="flex-1 flex flex-col min-h-0 bg-white rounded-lg border border-gray-200">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto space-y-4 p-3 sm:p-5 min-h-0">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center space-y-3 py-6">
                <div className="w-12 h-12 bg-blue-50 rounded-full flex items-center justify-center">
                  <MessageSquare className="w-6 h-6 text-blue-400" />
                </div>
                <div>
                  <p className="font-medium text-gray-700 text-sm sm:text-base">Ready to answer engineering questions</p>
                  <p className="mt-3 text-xs sm:text-sm text-gray-400">Examples:</p>
                  <p className="mt-1 text-xs sm:text-sm text-gray-400 italic">"What are the main components of the hydraulic system?"</p>
                  <p className="text-xs sm:text-sm text-gray-400 italic hidden sm:block">"How does the cooling subsystem connect to the engine?"</p>
                  <p className="text-xs sm:text-sm text-gray-400 italic hidden sm:block">"What safety procedures apply before maintenance?"</p>
                  <p className="mt-2 text-xs sm:text-sm text-gray-400 flex items-center justify-center gap-1.5">
                    <Image className="w-3.5 h-3.5 shrink-0" />
                    Attach a photo to identify parts or check condition
                  </p>
                </div>
              </div>
            )}

            {messages.map((msg, idx) => {
              const translation = translations[msg.id];
              const displayText =
                msg.role === "assistant" && !msg.pending && translation?.text
                  ? translation.text
                  : msg.content;

              // For feedback, find the preceding user question
              const precedingUserMsg = msg.role === "assistant"
                ? messages.slice(0, idx).reverse().find((m) => m.role === "user")
                : undefined;
              const questionForFeedback = precedingUserMsg?.content ?? "";

              return (
                <div
                  key={msg.id}
                  className={cn(
                    "flex gap-2 sm:gap-3",
                    msg.role === "user" ? "justify-end" : "justify-start"
                  )}
                >
                  {msg.role === "assistant" && (
                    <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0 mt-0.5">
                      <Bot className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-600" />
                    </div>
                  )}

                  <div
                    className={cn(
                      "space-y-2",
                      msg.role === "user"
                        ? "max-w-[82%] items-end"
                        : "flex-1 min-w-0 items-start"
                    )}
                  >
                    {/* User image attachment */}
                    {msg.role === "user" && msg.imageDataUrl && (
                      <div className="flex justify-end">
                        <img
                          src={msg.imageDataUrl}
                          alt="Attached photo"
                          className="max-w-[200px] sm:max-w-[260px] max-h-[180px] rounded-xl border border-blue-200 object-cover shadow-sm"
                        />
                      </div>
                    )}

                    {/* Bubble */}
                    {(msg.content || msg.pending) && (
                      <div
                        className={cn(
                          "rounded-xl px-3 sm:px-4 py-2.5 sm:py-3 text-sm leading-relaxed",
                          msg.role === "user"
                            ? "bg-blue-600 text-white"
                            : "bg-gray-50 border border-gray-200 text-gray-800"
                        )}
                      >
                        {msg.pending ? (
                          <span className="flex items-center gap-2 text-gray-400">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            {agentMode ? "Searching + validating…" : "Searching manuals…"}
                          </span>
                        ) : translation?.loading ? (
                          <span className="flex items-center gap-2 text-gray-400">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Translating…
                          </span>
                        ) : msg.role === "user" ? (
                          <span className="whitespace-pre-wrap">{displayText}</span>
                        ) : (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            className={cn(
                              "prose prose-sm max-w-none",
                              "prose-p:my-1 prose-p:leading-relaxed",
                              "prose-ol:my-1.5 prose-ol:pl-5 prose-ol:space-y-1",
                              "prose-ul:my-1.5 prose-ul:pl-5 prose-ul:space-y-1",
                              "prose-li:my-0 prose-li:leading-relaxed",
                              "prose-strong:font-semibold prose-strong:text-gray-900",
                              "prose-code:bg-gray-100 prose-code:text-gray-800 prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.8em] prose-code:before:content-none prose-code:after:content-none",
                              "prose-headings:font-semibold prose-headings:text-gray-900 prose-h3:text-sm prose-h4:text-sm",
                              "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
                              "text-gray-800 text-sm",
                            )}
                          >
                            {displayText}
                          </ReactMarkdown>
                        )}
                      </div>
                    )}

                    {/* Confidence badge + domain tag (agent mode only) */}
                    {!msg.pending && msg.role === "assistant" && msg.confidence && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ConfidenceBadge level={msg.confidence} />
                        {msg.domain && DOMAIN_LABELS[msg.domain] && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border bg-blue-50 text-blue-600 border-blue-200">
                            {DOMAIN_LABELS[msg.domain]}
                          </span>
                        )}
                        {msg.isGuided && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border bg-orange-50 text-orange-600 border-orange-200">
                            <AlertTriangle className="w-2.5 h-2.5" />
                            Guided response
                          </span>
                        )}
                      </div>
                    )}

                    {/* Assistant action bars */}
                    {!msg.pending && msg.role === "assistant" && msg.content && (
                      <div className="flex flex-wrap gap-2">
                        <TranslateBar
                          messageId={msg.id}
                          originalText={msg.content}
                          translation={translation}
                          onChange={handleTranslate}
                        />
                        <FeedbackBar
                          state={feedbackStates[msg.id]}
                          onThumbsUp={() => handleThumbsUp(msg, questionForFeedback)}
                          onThumbsDown={() => handleThumbsDown(msg, questionForFeedback)}
                        />
                      </div>
                    )}

                    {/* Citations */}
                    {!msg.pending && msg.role === "assistant" && msg.citations && msg.citations.length > 0 && (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5 px-1">
                          <BookOpen className="w-3 h-3 text-gray-400" />
                          <span className="text-[11px] text-gray-400 font-medium">
                            {msg.citations.length} source{msg.citations.length !== 1 ? "s" : ""} — tap to open PDF
                          </span>
                        </div>
                        <div className="space-y-1">
                          {msg.citations.map((c, i) => (
                            <CitationChip key={i} citation={c} index={i} />
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Evidence + Validation panels (agent mode only) */}
                    {!msg.pending && msg.role === "assistant" && msg.evidenceSummary && (
                      <EvidencePanel
                        evidence={msg.evidenceSummary}
                        open={expandedPanels[msg.id]?.evidence ?? false}
                        onToggle={() => togglePanel(msg.id, "evidence")}
                      />
                    )}
                    {!msg.pending && msg.role === "assistant" && msg.missingOrWeakEvidence && msg.missingOrWeakEvidence.length > 0 && (
                      <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800 flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 mt-0.5 shrink-0" />
                        <div>
                          <span className="font-medium">Partial evidence: </span>
                          {msg.missingOrWeakEvidence.slice(0, 2).map((item, i) => (
                            <span key={i}>
                              {i > 0 && " · "}
                              <span className="italic">{item.claimOrQuestionPart}</span>
                              {" "}
                              <span className="text-yellow-600">({item.issue})</span>
                            </span>
                          ))}
                          {msg.missingOrWeakEvidence.length > 2 && (
                            <span className="text-yellow-600"> +{msg.missingOrWeakEvidence.length - 2} more</span>
                          )}
                        </div>
                      </div>
                    )}
                    {!msg.pending && msg.role === "assistant" && msg.validationSummary && (
                      <ValidationPanel
                        validation={msg.validationSummary}
                        validationMetadata={msg.validationMetadata}
                        open={expandedPanels[msg.id]?.validation ?? false}
                        onToggle={() => togglePanel(msg.id, "validation")}
                      />
                    )}
                  </div>

                  {msg.role === "user" && (
                    <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gray-100 flex items-center justify-center shrink-0 mt-0.5">
                      <User className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-gray-500" />
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {/* Input bar */}
          <div className="shrink-0 border-t border-gray-100 pt-2.5 px-3 sm:px-4 pb-3">
            {attachedImage && (
              <div className="mb-2 flex items-start gap-2">
                <div className="relative inline-block">
                  <img
                    src={attachedImage}
                    alt="Attached"
                    className="h-14 w-14 object-cover rounded-lg border border-gray-200 shadow-sm"
                  />
                  <button
                    onClick={() => setAttachedImage(null)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-700 hover:bg-gray-900 text-white rounded-full flex items-center justify-center shadow"
                    title="Remove image"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
                <span className="text-xs text-gray-400 mt-1">Photo attached</span>
              </div>
            )}

            <div className="flex gap-2 items-end">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={handleImageSelect}
              />

              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading}
                title="Attach a photo"
                className={cn(
                  "h-10 w-10 shrink-0 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-colors",
                  attachedImage ? "border-blue-300 bg-blue-50 text-blue-600" : "text-gray-400"
                )}
              >
                <Paperclip className="w-4 h-4" />
              </Button>

              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={attachedImage ? "Ask about this photo…" : "Ask about your manuals…"}
                className="resize-none text-sm min-h-[40px] max-h-[120px] bg-gray-50 border-gray-200 rounded-xl text-gray-800 placeholder:text-gray-400"
                disabled={isLoading}
                rows={1}
              />

              <Button
                onClick={handleSend}
                disabled={!canSend}
                size="icon"
                className="h-10 w-10 shrink-0 rounded-xl bg-blue-600 hover:bg-blue-700"
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
            <p className="text-[11px] text-gray-400 mt-1.5 hidden sm:block">
              Shift+Enter for new line · attach a photo to identify parts or check condition
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
