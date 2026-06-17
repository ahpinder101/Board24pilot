import { Router } from "express";
import { db } from "@workspace/db";
import {
  manualsTable,
  entitiesTable,
  relationshipsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { GetEntityParams } from "@workspace/api-zod";

const router = Router();

// GET /graph — combined graph across all manuals
router.get("/graph", async (req, res) => {
  const nodes = await db
    .select({
      id: entitiesTable.id,
      manualId: entitiesTable.manualId,
      name: entitiesTable.name,
      type: entitiesTable.type,
      description: entitiesTable.description,
      properties: entitiesTable.properties,
      pageReferences: entitiesTable.pageReferences,
      orderIndex: entitiesTable.orderIndex,
      manualName: manualsTable.name,
    })
    .from(entitiesTable)
    .leftJoin(manualsTable, eq(entitiesTable.manualId, manualsTable.id));

  const edges = await db.select().from(relationshipsTable);

  res.json({ nodes, edges });
});

// GET /stats — global stats
router.get("/stats", async (req, res) => {
  const [manualCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(manualsTable);

  const [completedCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(manualsTable)
    .where(eq(manualsTable.status, "completed"));

  const [processingCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(manualsTable)
    .where(eq(manualsTable.status, "processing"));

  const [entityCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(entitiesTable);

  const [relCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(relationshipsTable);

  const entityTypes = await db
    .select({
      type: entitiesTable.type,
      count: sql<number>`count(*)::int`,
    })
    .from(entitiesTable)
    .groupBy(entitiesTable.type);

  const relTypes = await db
    .select({
      type: relationshipsTable.type,
      count: sql<number>`count(*)::int`,
    })
    .from(relationshipsTable)
    .groupBy(relationshipsTable.type);

  const entitiesByType: Record<string, number> = {};
  for (const row of entityTypes) entitiesByType[row.type] = row.count;

  const relationshipsByType: Record<string, number> = {};
  for (const row of relTypes) relationshipsByType[row.type] = row.count;

  res.json({
    totalManuals: manualCount?.count ?? 0,
    totalEntities: entityCount?.count ?? 0,
    totalRelationships: relCount?.count ?? 0,
    completedManuals: completedCount?.count ?? 0,
    processingManuals: processingCount?.count ?? 0,
    entitiesByType,
    relationshipsByType,
  });
});

// GET /entities/:id
router.get("/entities/:id", async (req, res) => {
  const parsed = GetEntityParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const [entity] = await db
    .select({
      id: entitiesTable.id,
      manualId: entitiesTable.manualId,
      name: entitiesTable.name,
      type: entitiesTable.type,
      description: entitiesTable.description,
      properties: entitiesTable.properties,
      pageReferences: entitiesTable.pageReferences,
      orderIndex: entitiesTable.orderIndex,
      manualName: manualsTable.name,
    })
    .from(entitiesTable)
    .leftJoin(manualsTable, eq(entitiesTable.manualId, manualsTable.id))
    .where(eq(entitiesTable.id, parsed.data.id));

  if (!entity) {
    res.status(404).json({ error: "Entity not found" });
    return;
  }

  const outgoing = await db
    .select()
    .from(relationshipsTable)
    .where(eq(relationshipsTable.sourceEntityId, parsed.data.id));

  const incoming = await db
    .select()
    .from(relationshipsTable)
    .where(eq(relationshipsTable.targetEntityId, parsed.data.id));

  res.json({
    entity,
    incomingEdges: incoming,
    outgoingEdges: outgoing,
  });
});

export default router;
