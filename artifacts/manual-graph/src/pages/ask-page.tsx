import { useState, useRef, useEffect } from "react";
import {
  Bot, User, Send, BookOpen, Loader2, MessageSquare, ExternalLink,
  FileText, Paperclip, X, Image, Globe, ThumbsUp, ThumbsDown,
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
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  imageDataUrl?: string;
  citations?: Citation[];
  pending?: boolean;
}

interface FeedbackState {
  rating: "positive" | "negative";
  submitted: boolean;
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      const body: Record<string, unknown> = { question, sessionId };
      if (imageSnapshot) body.imageDataUrl = imageSnapshot;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("Request failed");

      const data = await res.json() as {
        answer: string;
        citations: Citation[];
        sessionId: string;
      };

      setSessionId(data.sessionId);
      setMessages((prev) =>
        prev.map((m) =>
          m.pending
            ? { ...m, content: data.answer, citations: data.citations, pending: false }
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
          <h1 className="text-lg sm:text-xl font-bold text-gray-900">Ask Engineer</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-0.5 hidden sm:block">
            Ask anything about your uploaded manuals — or attach a photo of a part and ask about it.
          </p>
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
                            Searching manuals…
                          </span>
                        ) : translation?.loading ? (
                          <span className="flex items-center gap-2 text-gray-400">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Translating…
                          </span>
                        ) : (
                          <span className="whitespace-pre-wrap">{displayText}</span>
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
