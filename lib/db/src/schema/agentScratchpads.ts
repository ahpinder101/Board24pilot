import { pgTable, uuid, text, integer, numeric, timestamp, jsonb } from "drizzle-orm/pg-core";

export const agentScratchpadsTable = pgTable("agent_scratchpads", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: text("conversation_id").notNull(),
  agentName: text("agent_name").notNull(),
  scratchpadType: text("scratchpad_type").notNull().default("run"),
  question: text("question"),
  domain: text("domain"),
  documentIds: text("document_ids").array(),
  evidenceIds: text("evidence_ids").array(),
  tags: text("tags").array(),
  scratchpad: jsonb("scratchpad"),
  tokenEstimate: integer("token_estimate"),
  usefulnessScore: numeric("usefulness_score"),
  staleAfter: timestamp("stale_after"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  compressedFromIds: uuid("compressed_from_ids").array(),
});

export type AgentScratchpad = typeof agentScratchpadsTable.$inferSelect;
export type InsertAgentScratchpad = typeof agentScratchpadsTable.$inferInsert;
