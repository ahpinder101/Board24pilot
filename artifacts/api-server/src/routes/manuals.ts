import { Router } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import {
  manualsTable,
  entitiesTable,
  relationshipsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  CreateManualBody,
  GetManualParams,
  DeleteManualParams,
  ProcessManualParams,
  GetManualStatsParams,
  GetManualGraphParams,
} from "@workspace/api-zod";
import { ObjectStorageService } from "../lib/objectStorage.js";
import { runExtractionPipeline, rechunkManual, reprocessManualWithVision, reprocessPageRangeWithVision } from "../lib/extractionPipeline.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are accepted"));
    }
  },
});

const router = Router();
const storage = new ObjectStorageService();

// POST /manuals/upload — combined: receive PDF → store in GCS → create record → kick off processing
router.post("/manuals/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No PDF file provided" });
    return;
  }

  const filename = req.file.originalname;
  const buffer = req.file.buffer;
  const contentType = req.file.mimetype;

  let objectPath: string;
  try {
    objectPath = await storage.uploadBuffer(buffer, filename, contentType);
  } catch (err) {
    req.log.error({ err }, "Failed to upload PDF to object storage");
    res.status(500).json({ error: "Failed to store PDF" });
    return;
  }

  const name = filename.replace(/\.pdf$/i, "").replace(/[-_]/g, " ");
  const [manual] = await db
    .insert(manualsTable)
    .values({ name, filename, objectPath, status: "pending" })
    .returning();

  if (!manual) {
    res.status(500).json({ error: "Failed to create manual record" });
    return;
  }

  // Start pipeline in background
  runExtractionPipeline(manual.id, buffer).catch((err) => {
    req.log.error({ err, manualId: manual.id }, "Background extraction pipeline error");
  });

  res.status(201).json(manual);
});

// GET /manuals
router.get("/manuals", async (req, res) => {
  const manuals = await db.select().from(manualsTable).orderBy(manualsTable.createdAt);
  res.json(manuals);
});

// POST /manuals
router.post("/manuals", async (req, res) => {
  const parsed = CreateManualBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  const { name, filename, objectPath } = parsed.data;

  const [manual] = await db
    .insert(manualsTable)
    .values({ name, filename, objectPath, status: "pending" })
    .returning();

  res.status(201).json(manual);
});

// GET /manuals/:id
router.get("/manuals/:id", async (req, res) => {
  const parsed = GetManualParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const [manual] = await db
    .select()
    .from(manualsTable)
    .where(eq(manualsTable.id, parsed.data.id));

  if (!manual) {
    res.status(404).json({ error: "Manual not found" });
    return;
  }

  res.json(manual);
});

// DELETE /manuals/:id
router.delete("/manuals/:id", async (req, res) => {
  const parsed = DeleteManualParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  await db.delete(manualsTable).where(eq(manualsTable.id, parsed.data.id));
  res.status(204).end();
});

// POST /manuals/:id/process — trigger multi-pass AI extraction
router.post("/manuals/:id/process", async (req, res) => {
  const parsed = ProcessManualParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const [manual] = await db
    .select()
    .from(manualsTable)
    .where(eq(manualsTable.id, parsed.data.id));

  if (!manual) {
    res.status(404).json({ error: "Manual not found" });
    return;
  }

  // If already processing or completed, return current state
  if (manual.status === "processing") {
    res.json(manual);
    return;
  }

  // Download the PDF from object storage
  let pdfBuffer: Buffer;
  try {
    const file = await storage.getObjectEntityFile(manual.objectPath);
    const chunks: Buffer[] = [];
    const stream = file.createReadStream();
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    pdfBuffer = Buffer.concat(chunks);
  } catch (err) {
    req.log.error({ err }, "Failed to download PDF for processing");
    res.status(500).json({ error: "Failed to download PDF from storage" });
    return;
  }

  // Clear any previous extraction data
  await db.delete(entitiesTable).where(eq(entitiesTable.manualId, parsed.data.id));

  // Start pipeline in background (don't await)
  const manualId = parsed.data.id;
  runExtractionPipeline(manualId, pdfBuffer).catch((err) => {
    req.log.error({ err, manualId }, "Background extraction pipeline error");
  });

  // Return updated manual immediately
  const [updated] = await db
    .select()
    .from(manualsTable)
    .where(eq(manualsTable.id, manualId));

  res.json(updated ?? manual);
});

// GET /manuals/:id/graph
router.get("/manuals/:id/graph", async (req, res) => {
  const parsed = GetManualGraphParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const nodes = await db
    .select()
    .from(entitiesTable)
    .where(eq(entitiesTable.manualId, parsed.data.id));

  const edges = await db
    .select()
    .from(relationshipsTable)
    .where(eq(relationshipsTable.manualId, parsed.data.id));

  res.json({ nodes, edges });
});

// GET /manuals/:id/stats
router.get("/manuals/:id/stats", async (req, res) => {
  const parsed = GetManualStatsParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const manualId = parsed.data.id;

  const [entityCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(entitiesTable)
    .where(eq(entitiesTable.manualId, manualId));

  const [relCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(relationshipsTable)
    .where(eq(relationshipsTable.manualId, manualId));

  const entityTypes = await db
    .select({
      type: entitiesTable.type,
      count: sql<number>`count(*)::int`,
    })
    .from(entitiesTable)
    .where(eq(entitiesTable.manualId, manualId))
    .groupBy(entitiesTable.type);

  const relTypes = await db
    .select({
      type: relationshipsTable.type,
      count: sql<number>`count(*)::int`,
    })
    .from(relationshipsTable)
    .where(eq(relationshipsTable.manualId, manualId))
    .groupBy(relationshipsTable.type);

  const entitiesByType: Record<string, number> = {};
  for (const row of entityTypes) entitiesByType[row.type] = row.count;

  const relationshipsByType: Record<string, number> = {};
  for (const row of relTypes) relationshipsByType[row.type] = row.count;

  res.json({
    manualId,
    totalEntities: entityCount?.count ?? 0,
    totalRelationships: relCount?.count ?? 0,
    entitiesByType,
    relationshipsByType,
  });
});

// POST /manuals/:id/reprocess-vision — admin: re-run full pipeline with GPT-4o vision OCR
// Use when a manual was processed as an image-based PDF and produced no entities/chunks.
router.post("/manuals/:id/reprocess-vision", async (req, res) => {
  const manualId = parseInt(req.params.id ?? "", 10);
  if (isNaN(manualId)) {
    res.status(400).json({ error: "Invalid manual id" });
    return;
  }

  const [manual] = await db
    .select()
    .from(manualsTable)
    .where(eq(manualsTable.id, manualId));

  if (!manual) {
    res.status(404).json({ error: "Manual not found" });
    return;
  }

  if (manual.status === "processing") {
    res.status(409).json({ error: "Manual is already processing" });
    return;
  }

  // Read PDF from object storage
  let pdfBuffer: Buffer;
  try {
    const storage = new ObjectStorageService();
    const file = await storage.getObjectEntityFile(manual.objectPath);
    const chunks: Buffer[] = [];
    const stream = file.createReadStream();
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    pdfBuffer = Buffer.concat(chunks);
  } catch (err) {
    req.log.error({ err, manualId }, "Failed to download PDF for vision reprocess");
    res.status(500).json({ error: "Failed to download PDF from storage" });
    return;
  }

  // Start reprocess in background
  reprocessManualWithVision(manualId, pdfBuffer).catch((err) => {
    req.log.error({ err, manualId }, "Vision reprocess pipeline error");
  });

  res.json({ ok: true, manualId, message: "Vision reprocess started" });
});

// POST /manuals/:id/reprocess-vision-pages — OCR a specific page range only
router.post("/manuals/:id/reprocess-vision-pages", async (req, res) => {
  const manualId = parseInt(req.params.id ?? "", 10);
  const startPage = parseInt(String(req.body?.startPage ?? ""), 10);
  const endPage = parseInt(String(req.body?.endPage ?? ""), 10);

  if (isNaN(manualId) || isNaN(startPage) || isNaN(endPage) || startPage < 1 || endPage < startPage) {
    res.status(400).json({ error: "Invalid params — need manualId, startPage (>=1), endPage (>=startPage)" });
    return;
  }

  const [manual] = await db.select().from(manualsTable).where(eq(manualsTable.id, manualId));
  if (!manual) { res.status(404).json({ error: "Manual not found" }); return; }

  let pdfBuffer: Buffer;
  try {
    const storage = new ObjectStorageService();
    const file = await storage.getObjectEntityFile(manual.objectPath);
    const parts: Buffer[] = [];
    const stream = file.createReadStream();
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (c) => parts.push(Buffer.from(c)));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    pdfBuffer = Buffer.concat(parts);
  } catch (err) {
    req.log.error({ err, manualId }, "Failed to download PDF for page-range OCR");
    res.status(500).json({ error: "Failed to download PDF" });
    return;
  }

  // Run synchronously — page ranges are small, caller wants the result
  try {
    const result = await reprocessPageRangeWithVision(manualId, pdfBuffer, startPage, endPage);
    res.json({ ok: true, manualId, startPage, endPage, ...result });
  } catch (err) {
    req.log.error({ err, manualId }, "Page-range vision OCR failed");
    res.status(500).json({ error: String(err) });
  }
});

// POST /manuals/:id/rechunk — admin: re-apply semantic chunker without full pipeline
router.post("/manuals/:id/rechunk", async (req, res) => {
  const manualId = parseInt(req.params.id ?? "", 10);
  if (isNaN(manualId)) {
    res.status(400).json({ error: "Invalid manual id" });
    return;
  }
  try {
    const result = await rechunkManual(manualId);
    res.json({ ok: true, manualId, ...result });
  } catch (err) {
    req.log.error({ err, manualId }, "Rechunk failed");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
