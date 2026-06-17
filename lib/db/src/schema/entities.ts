import { pgTable, serial, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { manualsTable } from "./manuals";

export const entitiesTable = pgTable("entities", {
  id: serial("id").primaryKey(),
  manualId: integer("manual_id").notNull().references(() => manualsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(), // machine | component | subsystem | process | part | material | sensor | system | assembly | document_section
  description: text("description").notNull().default(""),
  properties: jsonb("properties"),
  pageReferences: jsonb("page_references").$type<number[]>().default([]),
  orderIndex: integer("order_index"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertEntitySchema = createInsertSchema(entitiesTable).omit({ id: true, createdAt: true });
export type InsertEntity = z.infer<typeof insertEntitySchema>;
export type Entity = typeof entitiesTable.$inferSelect;

export const relationshipsTable = pgTable("relationships", {
  id: serial("id").primaryKey(),
  manualId: integer("manual_id").notNull().references(() => manualsTable.id, { onDelete: "cascade" }),
  sourceEntityId: integer("source_entity_id").notNull().references(() => entitiesTable.id, { onDelete: "cascade" }),
  targetEntityId: integer("target_entity_id").notNull().references(() => entitiesTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // contains | part_of | connects_to | depends_on | sequence | communicates_with | powers | controls | feeds_into | mounted_on
  label: text("label").notNull().default(""),
  orderIndex: integer("order_index"),
  properties: jsonb("properties"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertRelationshipSchema = createInsertSchema(relationshipsTable).omit({ id: true, createdAt: true });
export type InsertRelationship = z.infer<typeof insertRelationshipSchema>;
export type Relationship = typeof relationshipsTable.$inferSelect;
