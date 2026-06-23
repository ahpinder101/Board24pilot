import { pgTable, serial, text, integer, timestamp, jsonb, customType } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return "bytea"; },
  toDriver(val) { return val; },
  fromDriver(val) { return Buffer.isBuffer(val) ? val : Buffer.from(val as unknown as string, "hex"); },
});

export const manualsTable = pgTable("manuals", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  filename: text("filename").notNull(),
  objectPath: text("object_path").notNull(),
  status: text("status").notNull().default("pending"), // pending | processing | completed | failed
  processingPass: integer("processing_pass"),
  totalPages: integer("total_pages"),
  documentType: text("document_type"),
  structure: jsonb("structure").$type<{ overview: string; machines: string[]; sections: string[] }>(),
  errorMessage: text("error_message"),
  currentActivity: text("current_activity"),
  pdfData: bytea("pdf_data"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertManualSchema = createInsertSchema(manualsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertManual = z.infer<typeof insertManualSchema>;
export type Manual = typeof manualsTable.$inferSelect;

export const manualPagesTable = pgTable("manual_pages", {
  id: serial("id").primaryKey(),
  manualId: integer("manual_id").notNull().references(() => manualsTable.id, { onDelete: "cascade" }),
  pageNumber: integer("page_number").notNull(),
  rawText: text("raw_text"),
  imageObjectPath: text("image_object_path"),
  hasImages: integer("has_images").notNull().default(0), // 0 or 1
  hasTables: integer("has_tables").notNull().default(0), // 0 or 1
  /** 1 when Docling returned at least one structural element for this page. */
  doclingExtracted: integer("docling_extracted").notNull().default(0),
  /** Number of Docling structural elements returned for this page. */
  doclingElementCount: integer("docling_element_count").notNull().default(0),
  /** 1 when Vision OCR was explicitly run to repair or enrich this page. */
  visionEscalated: integer("vision_escalated").notNull().default(0),
  description: text("description"),
  // Printed page number as it appears in the document header/footer (e.g. "7" for PDF
  // page 16 of a manual whose first 9 pages are cover/TOC). Populated by Docling extraction;
  // NULL for manuals processed before Docling was integrated.
  printedPageNumber: text("printed_page_number"),
  /** Number of picture/diagram elements on this page (from Docling). Null for pdf-parse fallback. */
  pictureCount: integer("picture_count").default(0),
  /** Pipe-separated captions of picture elements on this page (from Docling), if any. */
  pictureCaptions: text("picture_captions"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertManualPageSchema = createInsertSchema(manualPagesTable).omit({ id: true, createdAt: true });
export type InsertManualPage = z.infer<typeof insertManualPageSchema>;
export type ManualPage = typeof manualPagesTable.$inferSelect;
