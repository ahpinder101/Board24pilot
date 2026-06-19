import { Router, type Request, type Response } from "express";
import multer from "multer";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { db } from "@workspace/db";
import {
  manualsTable,
  entitiesTable,
  relationshipsTable,
  manualPagesTable,
} from "@workspace/db";
import { eq, sql, and, ne } from "drizzle-orm";
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
import { expensiveOpLimiter } from "../middlewares/rateLimit.js";

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
  currentActivity: manualsTable.currentActivity,
  createdAt: manualsTable.createdAt,
  updatedAt: manualsTable.updatedAt,
};

function getPdfBuffer(manual: { pdfData?: Buffer | null }): Buffer {
  if (!manual.pdfData) throw new Error("PDF not stored in database — please re-upload this manual");
  return Buffer.isBuffer(manual.pdfData) ? manual.pdfData : Buffer.from(manual.pdfData as unknown as string, "hex");
}

// Atomically claim a manual for processing. Flips status -> "processing" only if it
// isn't already, in a single UPDATE so concurrent/burst requests can't both win.
// Returns true if this caller claimed the job, false if one is already running.
async function claimForProcessing(manualId: number): Promise<boolean> {
  const claimed = await db
    .update(manualsTable)
    .set({ status: "processing", updatedAt: new Date() })
    .where(and(eq(manualsTable.id, manualId), ne(manualsTable.status, "processing")))
    .returning({ id: manualsTable.id });
  return claimed.length > 0;
}

// POST /manuals/upload — combined: receive PDF → store in DB → create record → kick off processing
router.post("/manuals/upload", expensiveOpLimiter, upload.single("file"), async (req, res) => {
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
router.post("/manuals/:id/process", expensiveOpLimiter, async (req, res) => {
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

  // Read PDF from database
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = getPdfBuffer(manual);
  } catch (err) {
    req.log.error({ err }, "Failed to read PDF from database");
    res.status(500).json({ error: String(err) });
    return;
  }

  // Atomically claim the job — rejects if one is already running (prevents
  // duplicate full-document extraction jobs on the same manual).
  if (!(await claimForProcessing(parsed.data.id))) {
    res.status(409).json({ error: "Manual is already processing" });
    return;
  }

  // Clear any previous extraction data. If this fails after claiming, release the
  // claim so the manual isn't left stuck in "processing" with no job running.
  const manualId = parsed.data.id;
  try {
    await db.delete(entitiesTable).where(eq(entitiesTable.manualId, manualId));
  } catch (err) {
    await db
      .update(manualsTable)
      .set({ status: "failed", errorMessage: String(err), updatedAt: new Date() })
      .where(eq(manualsTable.id, manualId));
    req.log.error({ err, manualId }, "Failed to clear prior extraction data");
    res.status(500).json({ error: String(err) });
    return;
  }

  // Start pipeline in background (don't await)
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
router.post("/manuals/:id/reprocess-vision", expensiveOpLimiter, async (req, res) => {
  const manualId = parseInt(String(req.params.id ?? ""), 10);
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

  // Read PDF from database
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = getPdfBuffer(manual);
  } catch (err) {
    req.log.error({ err, manualId }, "Failed to read PDF from database for vision reprocess");
    res.status(500).json({ error: String(err) });
    return;
  }

  // Atomically claim the job — rejects if one is already running.
  if (!(await claimForProcessing(manualId))) {
    res.status(409).json({ error: "Manual is already processing" });
    return;
  }

  // Start reprocess in background
  reprocessManualWithVision(manualId, pdfBuffer).catch((err) => {
    req.log.error({ err, manualId }, "Vision reprocess pipeline error");
  });

  res.json({ ok: true, manualId, message: "Vision reprocess started" });
});

// POST /manuals/:id/reprocess-vision-pages — OCR a specific page range only
router.post("/manuals/:id/reprocess-vision-pages", expensiveOpLimiter, async (req, res) => {
  const manualId = parseInt(String(req.params.id ?? ""), 10);
  const startPage = parseInt(String(req.body?.startPage ?? ""), 10);
  const endPage = parseInt(String(req.body?.endPage ?? ""), 10);

  if (isNaN(manualId) || isNaN(startPage) || isNaN(endPage) || startPage < 1 || endPage < startPage) {
    res.status(400).json({ error: "Invalid params — need manualId, startPage (>=1), endPage (>=startPage)" });
    return;
  }

  const [manual] = await db.select().from(manualsTable).where(eq(manualsTable.id, manualId));
  if (!manual) { res.status(404).json({ error: "Manual not found" }); return; }

  // Clamp the range to the document's real page count so a caller can't request
  // a huge range (e.g. 1..999999) and force one vision LLM call per phantom page.
  const maxPage = manual.totalPages ?? startPage;
  if (startPage > maxPage) {
    res.status(400).json({ error: `startPage exceeds document length (${maxPage} pages)` });
    return;
  }
  const boundedEnd = Math.min(endPage, maxPage);

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
    const result = await reprocessPageRangeWithVision(manualId, pdfBuffer, startPage, boundedEnd);
    res.json({ ok: true, manualId, startPage, endPage, ...result });
  } catch (err) {
    req.log.error({ err, manualId }, "Page-range vision OCR failed");
    res.status(500).json({ error: String(err) });
  }
});

// GET /manuals/:id/extraction-plan — compute extraction tiers from actual page text stats
// Returns real token counts and rationale derived from the manual's extracted content.
router.get("/manuals/:id/extraction-plan", async (req, res) => {
  const manualId = parseInt(String(req.params.id ?? ""), 10);
  if (isNaN(manualId)) { res.status(400).json({ error: "Invalid manual id" }); return; }

  const [manual] = await db.select().from(manualsTable).where(eq(manualsTable.id, manualId));
  if (!manual) { res.status(404).json({ error: "Manual not found" }); return; }

  // Query actual page texts (ordered by page number)
  const pages = await db
    .select({ pageNumber: manualPagesTable.pageNumber, rawText: manualPagesTable.rawText })
    .from(manualPagesTable)
    .where(eq(manualPagesTable.manualId, manualId))
    .orderBy(manualPagesTable.pageNumber);

  const totalPages = manual.totalPages ?? pages.length;

  // Content pages = pages with >50 chars of substantive text
  const contentPages = pages.filter(p => (p.rawText?.length ?? 0) > 50);
  const totalTextChars = pages.reduce((s, p) => s + (p.rawText?.length ?? 0), 0);
  const avgCharsPerPage = contentPages.length > 0
    ? Math.round(totalTextChars / contentPages.length)
    : 400;

  const densityLabel =
    avgCharsPerPage < 500  ? "sparse"    :
    avgCharsPerPage < 1000 ? "light"     :
    avgCharsPerPage < 1500 ? "moderate"  :
    avgCharsPerPage < 2000 ? "dense"     : "very dense";

  // Build cumulative text chart — lets us find the page where X% of text is covered
  const cumByPage: { page: number; cumChars: number }[] = [];
  let cum = 0;
  for (const p of pages) {
    cum += p.rawText?.length ?? 0;
    cumByPage.push({ page: p.pageNumber, cumChars: cum });
  }
  function pageAtRatio(ratio: number): number {
    if (ratio >= 1 || cumByPage.length === 0) return totalPages;
    const target = totalTextChars * ratio;
    const entry = cumByPage.find(e => e.cumChars >= target);
    return entry ? Math.min(entry.page, totalPages) : totalPages;
  }

  // Recommended ratio: denser text = entities saturate faster = lower ratio needed
  const recRatio =
    avgCharsPerPage > 2000 ? 0.28 :
    avgCharsPerPage > 1500 ? 0.35 :
    avgCharsPerPage > 1000 ? 0.42 :
    avgCharsPerPage > 500  ? 0.55 : 0.75;

  // Tier page counts — quick < recommended < full always
  // Quick: ~20% of pages, min 3, max 30, never reaches full
  const quickPages = Math.max(3, Math.min(
    Math.round(totalPages * 0.20),
    30,
    Math.max(1, totalPages - 1)          // always less than full
  ));
  // Recommended: density-ratio for large docs; ~65% floor for small docs
  const recommendedRaw = totalPages <= 30
    ? Math.round(totalPages * 0.65)
    : Math.min(pageAtRatio(recRatio), 400, totalPages);
  const recommendedPages = Math.max(quickPages + 1, Math.min(recommendedRaw, totalPages));
  const fullPages        = totalPages;

  // Token model constants (computed from actual prompt sizes in extractionPipeline.ts)
  const ENTITY_INPUT_PER_CALL = 1826;  // system prompt + 5,000-char chunk
  const REL_INPUT_BASE        = 1360;  // system prompt + 4,000-char chunk (no entities)
  const REL_INPUT_PER_ENTITY  = 6;     // ~20 chars per entity name / 3.5 chars·tok⁻¹
  const FIXED_INPUT           = 2400 + 1528; // pass1 + pass6
  const FIXED_OUTPUT_TYP      = 600 + 600;

  // Density-informed output token estimates (entities per chunk depend on content richness)
  const entityOutputTyp =
    avgCharsPerPage > 1800 ? 2000 :
    avgCharsPerPage > 1200 ? 1600 :
    avgCharsPerPage > 700  ? 1000 : 640;
  const relOutputTyp =
    avgCharsPerPage > 1800 ? 1800 :
    avgCharsPerPage > 1200 ? 1250 :
    avgCharsPerPage > 700  ? 800  : 500;

  function buildTier(pageCount: number): {
    pages: number; entityChunks: number; relChunks: number;
    totalInputTokens: number; outputTokensLow: number; outputTokensTypical: number; outputTokensHigh: number;
    rationale: string;
  } {
    // Use actual cumulative char count at the page boundary
    const charsToProcess = cumByPage.find(e => e.page >= pageCount)?.cumChars
      ?? Math.round((pageCount / (totalPages || 1)) * totalTextChars);

    const entityChunks    = Math.max(1, Math.ceil(charsToProcess / 5000));
    const relChunks       = Math.max(1, Math.ceil(entityChunks * 0.75));
    const estimatedEntities = entityChunks * 20;
    const relInputTokens  = REL_INPUT_BASE + estimatedEntities * REL_INPUT_PER_ENTITY;

    const totalInputTokens = (entityChunks * ENTITY_INPUT_PER_CALL)
      + (relChunks * relInputTokens)
      + FIXED_INPUT;

    const outputLow     = Math.round((entityChunks * entityOutputTyp * 0.4) + (relChunks * relOutputTyp * 0.4) + FIXED_OUTPUT_TYP);
    const outputTypical = (entityChunks * entityOutputTyp) + (relChunks * relOutputTyp) + FIXED_OUTPUT_TYP;
    const outputHigh    = Math.round((entityChunks * entityOutputTyp * 1.75) + (relChunks * relOutputTyp * 1.75) + FIXED_OUTPUT_TYP);

    return { pages: pageCount, entityChunks, relChunks, totalInputTokens, outputTokensLow: outputLow, outputTokensTypical: outputTypical, outputTokensHigh: outputHigh, rationale: "" };
  }

  const quick = buildTier(quickPages);
  const recommended = buildTier(recommendedPages);
  const full = buildTier(fullPages);

  // Generate human-readable rationale from real data
  const docLabel = manual.documentType?.replace(/_/g, " ") ?? "document";

  quick.rationale =
    `First ${quickPages} of ${totalPages} pages — covers the introduction and main system descriptions. `
    + `Your manual has ${contentPages.length.toLocaleString()} content-rich pages averaging ${avgCharsPerPage.toLocaleString()} chars/page (${densityLabel} content). `
    + `Good for a quick first look.`;

  recommended.rationale =
    `${recommendedPages} pages (${Math.round(recommendedPages / totalPages * 100)}% of your ${docLabel}). `
    + `At ${avgCharsPerPage.toLocaleString()} chars/page (${densityLabel}), the text analysis shows ~${Math.round(recRatio * 100)}% of the document contains the bulk of unique entities — `
    + `entities tend to plateau after this point as the same components are referenced in different contexts. `
    + (totalPages > 300
      ? `The remaining ${(totalPages - recommendedPages).toLocaleString()} pages would add roughly 15–25% more entities at proportionally higher cost.`
      : `Short enough that this covers nearly everything.`);

  full.rationale =
    `All ${totalPages.toLocaleString()} pages — ${totalTextChars.toLocaleString()} characters of text across ${contentPages.length.toLocaleString()} content pages. `
    + (fullPages > 400
      ? `Compared to the recommended tier, this processes ${(full.totalInputTokens - recommended.totalInputTokens).toLocaleString()} more input tokens for a marginal increase in entity coverage.`
      : `Complete analysis for this document.`);

  res.json({
    totalTextChars,
    contentPages: contentPages.length,
    avgCharsPerPage,
    densityLabel,
    tiers: { quick, recommended, full },
  });
});

// POST /manuals/:id/extract-graph — run entity/relationship extraction on existing OCR text
// Accepts optional body: { entityChunks?: number, relChunks?: number }
// entityChunks controls how many 5,000-char chunks Pass 4 reads (~12 pages/chunk).
// relChunks controls how many 4,000-char chunks Pass 5 reads (~10 pages/chunk).
// Responds 202 immediately; extraction runs in background. Poll GET /manuals/:id for progress.
router.post("/manuals/:id/extract-graph", expensiveOpLimiter, async (req, res) => {
  const manualId = parseInt(String(req.params.id ?? ""), 10);
  if (isNaN(manualId)) { res.status(400).json({ error: "Invalid manual id" }); return; }
  const [manual] = await db.select().from(manualsTable).where(eq(manualsTable.id, manualId));
  if (!manual) { res.status(404).json({ error: "Manual not found" }); return; }

  const entityChunks = typeof req.body?.entityChunks === "number" ? Math.max(1, Math.min(req.body.entityChunks, 500)) : undefined;
  const relChunks = typeof req.body?.relChunks === "number" ? Math.max(1, Math.min(req.body.relChunks, 500)) : undefined;

  // Atomically claim the job — rejects if one is already running. Without this,
  // repeated calls would each spawn a full-document LLM extraction in parallel.
  if (!(await claimForProcessing(manualId))) {
    res.status(409).json({ error: "Manual is already processing" });
    return;
  }

  res.status(202).json({ ok: true, manualId, entityChunks, relChunks, message: "Graph extraction started — poll GET /api/manuals/:id for progress" });
  // Defer to next tick so the HTTP response flushes before the blocking AI work starts
  setImmediate(async () => {
    try {
      const result = await extractGraphFromExistingText(manualId, { entityChunks, relChunks });
      logger.info({ manualId, ...result }, "Graph extraction completed");
    } catch (err) {
      logger.error({ err, manualId }, "Graph extraction failed");
    }
  });
});

// POST /manuals/:id/reset-processing — unlock a stuck "processing" job so it can be re-triggered
router.post("/manuals/:id/reset-processing", async (req: Request, res: Response) => {
  const manualId = parseInt(String(req.params.id ?? ""), 10);
  if (isNaN(manualId)) {
    res.status(400).json({ error: "Invalid manual id" });
    return;
  }

  const [manual] = await db.select(manualCols).from(manualsTable).where(eq(manualsTable.id, manualId)).limit(1);
  if (!manual) {
    res.status(404).json({ error: "Manual not found" });
    return;
  }

  if (manual.status !== "processing" && manual.status !== "failed") {
    res.status(400).json({ error: `Manual is in state "${manual.status}" — nothing to reset` });
    return;
  }

  // processingPass >= 2 means text extraction (Pass 1+2) is complete; the pipeline
  // can resume from Pass 3 which now skips already-described pages from the DB.
  // processingPass >= 4 means Pass 3 is done; jump straight to entity extraction.
  const pass = manual.processingPass ?? 0;
  const resumeStatus = pass >= 4 ? "structure_complete" : pass >= 2 ? "pending" : "pending";

  const [updated] = await db
    .update(manualsTable)
    .set({ status: resumeStatus, currentActivity: null, updatedAt: new Date() })
    .where(eq(manualsTable.id, manualId))
    .returning(manualCols);

  req.log.info({ manualId, from: manual.status, to: resumeStatus }, "Processing reset by user");
  res.json(updated);
});

// POST /manuals/:id/rechunk — admin: re-apply semantic chunker without full pipeline
router.post("/manuals/:id/rechunk", expensiveOpLimiter, async (req, res) => {
  const manualId = parseInt(String(req.params.id ?? ""), 10);
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
