import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { manualsTable } from "./manuals";

export const chunksTable = pgTable(
  "chunks",
  {
    id: serial("id").primaryKey(),
    manualId: integer("manual_id")
      .notNull()
      .references(() => manualsTable.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("chunks_manual_id_idx").on(table.manualId)]
);

export type Chunk = typeof chunksTable.$inferSelect;
export type InsertChunk = typeof chunksTable.$inferInsert;
