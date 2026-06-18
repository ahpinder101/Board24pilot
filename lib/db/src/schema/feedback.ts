import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const feedbackTable = pgTable("feedback", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  rating: text("rating").notNull(),
  reason: text("reason"),
  correction: text("correction"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Feedback = typeof feedbackTable.$inferSelect;
export type InsertFeedback = typeof feedbackTable.$inferInsert;
