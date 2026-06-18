import { useState, useRef, useEffect } from "react";
import { Bot, User, Send, BookOpen, Network, Loader2, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  citations?: Citation[];
  graphEntities?: string[];
  pending?: boolean;
}

export default function AskPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedCitations, setSelectedCitations] = useState<Citation[] | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const question = input.trim();
    if (!question || isLoading) return;

    saveRecentQuestion(question);

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
    };
    const pendingMsg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      pending: true,
    };

    setMessages((prev) => [...prev, userMsg, pendingMsg]);
    setInput("");
    setIsLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, sessionId }),
      });

      if (!res.ok) throw new Error("Request failed");

      const data = await res.json() as {
        answer: string;
        citations: Citation[];
        sessionId: string;
        graphEntities?: string[];
      };

      setSessionId(data.sessionId);
      setMessages((prev) =>
        prev.map((m) =>
          m.pending
            ? {
                ...m,
                content: data.answer,
                citations: data.citations,
                graphEntities: data.graphEntities,
                pending: false,
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

  return (
    <div className="h-full flex flex-col max-w-7xl mx-auto w-full px-6 py-6">
      {/* Header */}
      <div className="mb-5 shrink-0">
        <h1 className="text-xl font-bold text-gray-900">Ask Engineer</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Ask anything about your uploaded manuals. Answers draw from both manual text and the knowledge graph.
        </p>
      </div>

      <div className="flex-1 flex gap-5 min-h-0">
        {/* Chat panel */}
        <div className="flex-1 flex flex-col min-h-0 bg-white rounded-lg border border-gray-200">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto space-y-4 p-5 min-h-0">
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

                <div className={cn("max-w-[80%] space-y-2", msg.role === "user" ? "items-end" : "items-start")}>
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
                        Searching manuals and graph...
                      </span>
                    ) : (
                      <span className="whitespace-pre-wrap">{msg.content}</span>
                    )}
                  </div>

                  {/* Citations & graph entities */}
                  {!msg.pending && msg.role === "assistant" && (
                    <div className="flex flex-wrap gap-2">
                      {msg.citations && msg.citations.length > 0 && (
                        <button
                          onClick={() =>
                            setSelectedCitations(
                              selectedCitations === msg.citations ? null : msg.citations!
                            )
                          }
                          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-blue-600 transition-colors border border-gray-200 hover:border-blue-300 rounded-full px-3 py-1 bg-white"
                        >
                          <BookOpen className="w-3 h-3" />
                          {msg.citations.length} source{msg.citations.length !== 1 ? "s" : ""}
                        </button>
                      )}
                      {msg.graphEntities && msg.graphEntities.length > 0 && (
                        <span className="flex items-center gap-1.5 text-xs text-gray-500 border border-gray-200 rounded-full px-3 py-1 bg-white">
                          <Network className="w-3 h-3" />
                          {msg.graphEntities.length} graph node{msg.graphEntities.length !== 1 ? "s" : ""}
                        </span>
                      )}
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
          <div className="shrink-0 px-5 pb-5 border-t border-gray-100 pt-4">
            <div className="flex gap-2 items-end">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask a question about your engineering manuals... (Enter to send)"
                className="resize-none text-sm min-h-[52px] max-h-[160px] bg-gray-50 border-gray-200 rounded-xl text-gray-800 placeholder:text-gray-400"
                disabled={isLoading}
                rows={2}
              />
              <Button
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                size="icon"
                className="h-[52px] w-[52px] shrink-0 rounded-xl bg-blue-600 hover:bg-blue-700"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Shift+Enter for new line · Answers cite manual pages and graph nodes
            </p>
          </div>
        </div>

        {/* Citations panel */}
        {selectedCitations && selectedCitations.length > 0 && (
          <div className="w-80 shrink-0 flex flex-col min-h-0 bg-white rounded-lg border border-gray-200">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
              <h2 className="text-sm font-semibold text-gray-700">Sources</h2>
              <button
                onClick={() => setSelectedCitations(null)}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
              {selectedCitations.map((c, i) => (
                <Card key={i} className="bg-gray-50 border-gray-200 text-xs shadow-none">
                  <CardHeader className="pb-2 pt-3 px-3">
                    <CardTitle className="text-xs flex items-center gap-2 text-gray-700">
                      <BookOpen className="w-3 h-3 text-blue-500 shrink-0" />
                      <span className="truncate">{c.manualName}</span>
                      {c.pageNumber && (
                        <Badge variant="secondary" className="ml-auto text-[10px] shrink-0 bg-gray-200 text-gray-600">
                          p.{c.pageNumber}
                        </Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-3 pb-3 space-y-2">
                    <p className="text-gray-500 leading-relaxed line-clamp-4">{c.excerpt}</p>
                    {c.entityNames && c.entityNames.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {c.entityNames.map((name) => (
                          <Badge key={name} variant="outline" className="text-[9px] text-blue-600 border-blue-200">
                            {name}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
