import { useState, useRef, useEffect } from "react";
import { Bot, User, Send, BookOpen, Loader2, MessageSquare, ExternalLink, FileText, Paperclip, X, Image } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { saveRecentQuestion } from "@/hooks/use-recent-questions";

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

function CitationChip({ citation, index }: { citation: Citation; index: number }) {
  const href = citation.pageNumber
    ? `/api/manuals/${citation.manualId}/pdf#page=${citation.pageNumber}`
    : `/api/manuals/${citation.manualId}/pdf`;

  const shortName = citation.manualName.length > 30
    ? citation.manualName.slice(0, 30) + "…"
    : citation.manualName;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`${citation.manualName}${citation.pageNumber ? ` · page ${citation.pageNumber}` : ""}\n\n${citation.excerpt}`}
      className="group flex items-start gap-2 px-3 py-2 rounded-lg border border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50 transition-colors text-left"
    >
      <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
        <span className="text-[10px] font-bold text-gray-400 w-4 text-center">{index + 1}</span>
        <FileText className="w-3.5 h-3.5 text-blue-400 shrink-0" />
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
    </a>
  );
}

export default function AskPage() {
  const [messages, setMessages] = useState<Message[]>([]);
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

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setAttachedImage(ev.target?.result as string);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const removeImage = () => {
    setAttachedImage(null);
  };

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

  return (
    <div className="h-full flex flex-col max-w-4xl mx-auto w-full px-6 py-6">
      {/* Header */}
      <div className="mb-5 shrink-0">
        <h1 className="text-xl font-bold text-gray-900">Ask Engineer</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Ask anything about your uploaded manuals — or attach a photo of a part and ask about it.
        </p>
      </div>

      {/* Chat */}
      <div className="flex-1 flex flex-col min-h-0 bg-white rounded-lg border border-gray-200">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto space-y-5 p-5 min-h-0">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-3">
              <div className="w-14 h-14 bg-blue-50 rounded-full flex items-center justify-center">
                <MessageSquare className="w-7 h-7 text-blue-400" />
              </div>
              <div>
                <p className="font-medium text-gray-700">Ready to answer engineering questions</p>
                <p className="mt-3 text-sm text-gray-400">Examples:</p>
                <p className="mt-1 text-sm text-gray-400 italic">"What are the main components of the hydraulic system?"</p>
                <p className="text-sm text-gray-400 italic">"How does the cooling subsystem connect to the engine?"</p>
                <p className="text-sm text-gray-400 italic">"What safety procedures apply before maintenance?"</p>
                <p className="mt-2 text-sm text-gray-400 flex items-center justify-center gap-1.5">
                  <Image className="w-3.5 h-3.5" />
                  Or attach a photo of a part to identify it
                </p>
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={cn("flex gap-3", msg.role === "user" ? "justify-end" : "justify-start")}
            >
              {msg.role === "assistant" && (
                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-4 h-4 text-blue-600" />
                </div>
              )}

              <div className={cn("space-y-2", msg.role === "user" ? "max-w-[78%] items-end" : "flex-1 min-w-0 items-start")}>
                {/* Attached image (user messages) */}
                {msg.role === "user" && msg.imageDataUrl && (
                  <div className="flex justify-end">
                    <img
                      src={msg.imageDataUrl}
                      alt="Attached photo"
                      className="max-w-[260px] max-h-[200px] rounded-xl border border-blue-200 object-cover shadow-sm"
                    />
                  </div>
                )}

                {/* Bubble — only show if there's text */}
                {(msg.content || msg.pending) && (
                  <div
                    className={cn(
                      "rounded-xl px-4 py-3 text-sm leading-relaxed",
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
                    ) : (
                      <span className="whitespace-pre-wrap">{msg.content}</span>
                    )}
                  </div>
                )}

                {/* Inline citations */}
                {!msg.pending && msg.role === "assistant" && msg.citations && msg.citations.length > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 px-1">
                      <BookOpen className="w-3 h-3 text-gray-400" />
                      <span className="text-[11px] text-gray-400 font-medium">
                        {msg.citations.length} source{msg.citations.length !== 1 ? "s" : ""} — click to open PDF
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
                <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center shrink-0 mt-0.5">
                  <User className="w-4 h-4 text-gray-500" />
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="shrink-0 border-t border-gray-100 pt-3 px-4 pb-4">
          {/* Image preview */}
          {attachedImage && (
            <div className="mb-2 flex items-start gap-2">
              <div className="relative inline-block">
                <img
                  src={attachedImage}
                  alt="Attached"
                  className="h-16 w-16 object-cover rounded-lg border border-gray-200 shadow-sm"
                />
                <button
                  onClick={removeImage}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-700 hover:bg-gray-900 text-white rounded-full flex items-center justify-center shadow"
                  title="Remove image"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
              <span className="text-xs text-gray-400 mt-1">Photo attached — ask a question or send as-is</span>
            </div>
          )}

          <div className="flex gap-2 items-end">
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageSelect}
            />

            {/* Attach button */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading}
              title="Attach a photo"
              className={cn(
                "h-[44px] w-[44px] shrink-0 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-colors",
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
              placeholder={attachedImage ? "Ask about this photo… (or press Enter to send)" : "Ask a question about your engineering manuals… (Enter to send)"}
              className="resize-none text-sm min-h-[44px] max-h-[160px] bg-gray-50 border-gray-200 rounded-xl text-gray-800 placeholder:text-gray-400"
              disabled={isLoading}
              rows={1}
            />
            <Button
              onClick={handleSend}
              disabled={!canSend}
              size="icon"
              className="h-[44px] w-[44px] shrink-0 rounded-xl bg-blue-600 hover:bg-blue-700"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Shift+Enter for new line · attach a photo to identify parts or check condition
          </p>
        </div>
      </div>
    </div>
  );
}
