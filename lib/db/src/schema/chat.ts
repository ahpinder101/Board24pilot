import { pgTable, serial, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export type CitationQuality = "strong" | "partial" | "weak" | "unverified";

export interface ChatCitation {
  manualId: number;
  manualName: string;
  pageNumber?: number;
  excerpt: string;
  entityNames?: string[];
  citationQuality?: CitationQuality;
  /** Pass 8 page context — drawing number, spec sheet name, or section title for this chunk (e.g. "PP2 049 Feed Section Schematics — ORDER SPEC SHEET"). */
  pageContext?: string;
}

export interface AssistantDebugMetadata {
  domain?: string;
  manualsSearched?: string[];
  evidenceSummary?: {
    chunksFound: number;
    entitiesFound: number;
    pathsFound: number;
  };
  detectedSymbols?: string[];
  retrievalLanes?: string[];
  rescueStages?: string[];
  guidedReason?: string | null;
  validation?: {
    confidence?: string;
    answerability?: string;
    missingItems?: string[];
  };
}

export const chatMessagesTable = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  citations: jsonb("citations").$type<ChatCitation[]>(),
  debugMetadata: jsonb("debug_metadata").$type<AssistantDebugMetadata | null>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ChatMessage = typeof chatMessagesTable.$inferSelect;
export type InsertChatMessage = typeof chatMessagesTable.$inferInsert;
