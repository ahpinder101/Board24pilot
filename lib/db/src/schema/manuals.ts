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
  errorMessage: text("error_message"),
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
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertManualPageSchema = createInsertSchema(manualPagesTable).omit({ id: true, createdAt: true });
export type InsertManualPage = z.infer<typeof insertManualPageSchema>;
export type ManualPage = typeof manualPagesTable.$inferSelect;
