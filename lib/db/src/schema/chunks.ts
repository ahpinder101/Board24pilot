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
    /** Dominant Docling element type for this chunk: "text" | "list_item" | "table" | "section_header" | "mixed" | "semantic_expansion". Null for pdf-parse fallback chunks. */
    elementType: text("element_type"),
    /** Breadcrumb path of the section headers containing this chunk, e.g. "2. INSTALLATION > 2-3. Lubrication". Null for pdf-parse fallback chunks. */
    sectionPath: text("section_path"),
    /** Pass 8 — most specific page/section identifier available (manual name + drawing number, order number, section title etc.). Used to contextualise decontextualised chunks. */
    pageContext: text("page_context"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("chunks_manual_id_idx").on(table.manualId)]
);

export type Chunk = typeof chunksTable.$inferSelect;
export type InsertChunk = typeof chunksTable.$inferInsert;
