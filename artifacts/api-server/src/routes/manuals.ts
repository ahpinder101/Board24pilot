import { Router, type Request, type Response } from "express";
import multer from "multer";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { runExtractionPipeline, rechunkManual, reprocessManualWithVision, reprocessPageRangeWithVision, extractGraphFromExistingText } from "../lib/extractionPipeline.js";
import { logger } from "../lib/logger.js";

const upload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_req, file, cb) => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      cb(null, `upload-${unique}.pdf`);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB
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

// Columns to select when returning manuals to clients (excludes the large pdf_data blob)
const manualCols = {
  id: manualsTable.id,
  name: manualsTable.name,
  filename: manualsTable.filename,
  objectPath: manualsTable.objectPath,
  status: manualsTable.status,
  processingPass: manualsTable.processingPass,
  totalPages: manualsTable.totalPages,
  documentType: manualsTable.documentType,
  errorMessage: manualsTable.errorMessage,
  createdAt: manualsTable.createdAt,
  updatedAt: manualsTable.updatedAt,
};

function getPdfBuffer(manual: { pdfData?: Buffer | null }): Buffer {
  if (!manual.pdfData) throw new Error("PDF not stored in database — please re-upload this manual");
  return Buffer.isBuffer(manual.pdfData) ? manual.pdfData : Buffer.from(manual.pdfData as unknown as string, "hex");
}

// POST /manuals/upload — combined: receive PDF → store in DB → create record → kick off processing
router.post("/manuals/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No PDF file provided" });
    return;
  }

  const filename = req.file.originalname;
  const tempPath = (req.file as Express.Multer.File & { path: string }).path;

  // Read from temp file on disk (avoids holding 250MB+ in RAM during upload)
  let buffer: Buffer;
  try {
    buffer = await readFile(tempPath);
  } catch (err) {
    req.log.error({ err }, "Failed to read uploaded temp file");
    res.status(500).json({ error: "Failed to read uploaded file" });
    return;
  } finally {
    // Clean up temp file regardless of outcome
    unlink(tempPath).catch(() => {});
  }

  // PDF is stored directly in the database (GCS sidecar auth is unavailable)
  const objectPath = `/db/${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

  const name = filename.replace(/\.pdf$/i, "").replace(/[-_]/g, " ");
  const [manual] = await db
    .insert(manualsTable)
    .values({ name, filename, objectPath, status: "pending", pdfData: buffer })
    .returning();

  if (!manual) {
    res.status(500).json({ error: "Failed to create manual record" });
    return;
  }

  // Start pipeline in background
  runExtractionPipeline(manual.id, buffer).catch((err) => {
    req.log.error({ err, manualId: manual.id }, "Background extraction pipeline error");
  });

  const { pdfData: _, ...safeManual } = manual;
  res.status(201).json(safeManual);
});

// GET /manuals
router.get("/manuals", async (req, res) => {
  const manuals = await db.select(manualCols).from(manualsTable).orderBy(manualsTable.createdAt);
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
    .select(manualCols)
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

  // Read PDF from database
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = getPdfBuffer(manual);
  } catch (err) {
    req.log.error({ err }, "Failed to read PDF from database");
    res.status(500).json({ error: String(err) });
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
    .select(manualCols)
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

  // Read PDF from database
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = getPdfBuffer(manual);
  } catch (err) {
    req.log.error({ err, manualId }, "Failed to read PDF from database for vision reprocess");
    res.status(500).json({ error: String(err) });
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
    pdfBuffer = getPdfBuffer(manual);
  } catch (err) {
    req.log.error({ err, manualId }, "Failed to read PDF from database for page-range OCR");
    res.status(500).json({ error: String(err) });
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

// POST /manuals/:id/extract-graph — run entity/relationship extraction on existing OCR text
// Responds 202 immediately; extraction runs in background (can take 2-5 min).
// Poll GET /manuals/:id to check processingPass progress (1→4→5→6 = done).
router.post("/manuals/:id/extract-graph", async (req, res) => {
  const manualId = parseInt(req.params.id ?? "", 10);
  if (isNaN(manualId)) { res.status(400).json({ error: "Invalid manual id" }); return; }
  const [manual] = await db.select().from(manualsTable).where(eq(manualsTable.id, manualId));
  if (!manual) { res.status(404).json({ error: "Manual not found" }); return; }
  res.status(202).json({ ok: true, manualId, message: "Graph extraction started — poll GET /api/manuals/:id for progress" });
  // Defer to next tick so the HTTP response flushes before the blocking AI work starts
  setImmediate(async () => {
    try {
      const result = await extractGraphFromExistingText(manualId);
      logger.info({ manualId, ...result }, "Graph extraction completed");
    } catch (err) {
      logger.error({ err, manualId }, "Graph extraction failed");
    }
  });
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

// GET /manuals/:id/pdf — serve PDF stored in the database
router.get("/manuals/:id/pdf", async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid manual ID" });
    return;
  }

  const [manual] = await db
    .select()
    .from(manualsTable)
    .where(eq(manualsTable.id, id))
    .limit(1);

  if (!manual) {
    res.status(404).json({ error: "Manual not found" });
    return;
  }

  if (!manual.pdfData) {
    res.status(404).json({ error: "PDF not available — please re-upload this manual" });
    return;
  }

  const buf = Buffer.isBuffer(manual.pdfData) ? manual.pdfData : Buffer.from(manual.pdfData as unknown as string, "hex");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(manual.filename)}"`);
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.end(buf);
});

export default router;
