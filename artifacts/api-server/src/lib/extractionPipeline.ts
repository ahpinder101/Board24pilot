/**
 * Multi-pass AI extraction pipeline for engineering manuals.
 *
 * Pass 1: Document structure analysis (type, sections, overview)
 * Pass 2: Per-page content (text, image/table detection)
 * Pass 3: Vision pass — describe images and tables from page images
 * Pass 4: Entity extraction (machines, components, subsystems, processes, parts, etc.)
 * Pass 5: Relationship extraction (connects-to, part-of, contains, sequence, etc.)
 * Pass 6: Ordering & hierarchy (sequences, procedures, dependency order)
 * Pass 7: Embedding generation for RAG (chunks → pgvector)
 */

import { openai } from "./openai.js";
import { db } from "@workspace/db";
import {
  manualsTable,
  manualPagesTable,
  entitiesTable,
  relationshipsTable,
  chunksTable,
  pathsTable,
  type Manual,
  type ManualPage,
  type Entity,
  type InsertEntity,
  type InsertRelationship,
} from "@workspace/db";
import { eq, and, count, sql, isNotNull, gte, lte } from "drizzle-orm";
import { extractPdfText, renderPdfPageToBase64, renderPdfPageToBase64FromPath, hasDiagramImage, hasDiagramImageFromPath, writePdfToTempFile, chunkText, chunkPageSemantically, type PdfContent } from "./pdfExtractor.js";
import { Buffer } from "node:buffer";
import { logger } from "./logger.js";

const MODEL = "gpt-5.4";
const MAX_TOKENS = 8192;

/** Strip characters PostgreSQL UTF-8 rejects (null bytes, other C0 controls
 *  except tab/newline/CR) so PDF text can be stored without errors. */
function sanitizeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x00/g, "").replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, " ");
}

async function updateManualPass(manualId: number, pass: number) {
  await db
    .update(manualsTable)
    .set({ processingPass: pass, updatedAt: new Date() })
    .where(eq(manualsTable.id, manualId));
}

/** Write a human-readable activity message + bump updatedAt so the frontend
 *  heartbeat ticker can tell whether the pipeline is still making progress. */
async function setActivity(manualId: number, message: string) {
  await db
    .update(manualsTable)
    .set({ currentActivity: message, updatedAt: new Date() })
    .where(eq(manualsTable.id, manualId));
}

async function setManualStatus(
  manualId: number,
  status: string,
  extra?: Partial<typeof manualsTable.$inferInsert>
) {
  await db
    .update(manualsTable)
    .set({ status, updatedAt: new Date(), ...extra })
    .where(eq(manualsTable.id, manualId));
}

// ─── PASS 1: Document structure ────────────────────────────────────────────

async function pass1DocumentStructure(
  manualId: number,
  fullText: string,
  totalPages: number
): Promise<{ documentType: string; overview: string; machines: string[]; sections: string[] }> {
  await updateManualPass(manualId, 1);

  const sample = fullText.slice(0, 8000);
  const response = await openai.chat.completions.create({
    model: MODEL,
    max_completion_tokens: MAX_TOKENS,
    messages: [
      {
        role: "system",
        content: `You are an expert technical document analyst specializing in engineering manuals.
Analyze the document and return a JSON object with:
- documentType: one of "maintenance_manual", "operation_manual", "installation_manual", "parts_catalog", "technical_specification", "service_manual", "user_guide", "system_manual", or "other"
- overview: a concise 2-3 sentence description of what this manual covers
- machines: array of machine/equipment names mentioned (top-level machines only, 1-10 items)
- sections: array of main section names from the document`,
      },
      {
        role: "user",
        content: `Analyze this engineering manual (${totalPages} pages total). Here is the beginning of the document:\n\n${sample}`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(raw);
    return {
      documentType: parsed.documentType ?? "other",
      overview: parsed.overview ?? "",
      machines: Array.isArray(parsed.machines) ? parsed.machines : [],
      sections: Array.isArray(parsed.sections) ? parsed.sections : [],
    };
  } catch {
    return { documentType: "other", overview: "", machines: [], sections: [] };
  }
}

// ─── PASS 2: Per-page content analysis ─────────────────────────────────────

async function pass2PageContent(
  manualId: number,
  pages: Array<{ pageNumber: number; text: string; hasImages: boolean; hasTables: boolean }>
) {
  // Check which page numbers are already in the DB so we can skip them on resume.
  const existingRows = await db
    .select({ pageNumber: manualPagesTable.pageNumber })
    .from(manualPagesTable)
    .where(eq(manualPagesTable.manualId, manualId));
  const existingSet = new Set(existingRows.map((r) => r.pageNumber));

  const newPages = pages.filter((p) => !existingSet.has(p.pageNumber));
  if (newPages.length === 0) {
    // All pages already in DB — skip entirely without touching processingPass
    logger.info({ manualId, total: pages.length }, "Pass 2: all pages already in DB — skipping insert");
    return;
  }

  // Only advance processingPass when we're actually doing new work
  await updateManualPass(manualId, 2);

  if (existingSet.size > 0) {
    logger.info({ manualId, existing: existingSet.size, inserting: newPages.length }, "Pass 2: resuming — inserting remaining pages");
    await setActivity(manualId, `Pass 2 — resuming: ${existingSet.size} pages already saved, inserting ${newPages.length} remaining`);
  }

  const pageRecords = newPages.map((p) => ({
    manualId,
    pageNumber: p.pageNumber,
    rawText: sanitizeText(p.text),
    hasImages: p.hasImages ? 1 : 0,
    hasTables: p.hasTables ? 1 : 0,
  }));

  for (let i = 0; i < pageRecords.length; i += 20) {
    await db.insert(manualPagesTable).values(pageRecords.slice(i, i + 20));
  }
}

// ─── PASS 3: Vision / description pass ─────────────────────────────────────

async function pass3VisionDescriptions(
  manualId: number,
  fullText: string,
  pages: Array<{ pageNumber: number; text: string; hasImages: boolean; hasTables: boolean }>
): Promise<Map<number, string>> {
  await updateManualPass(manualId, 3);

  // For sparse non-image pages, generate context-based descriptions using AI.
  // Image pages are excluded — Pass 7's diagram gate handles them with true vision
  // analysis (more accurate than Pass 3's context-only guess), so describing them
  // here would waste an LLM call whose output Pass 7 overwrites anyway.
  // Tabular pages that still have substantial text are also excluded: their
  // description is never preferred downstream (consumers only swap in the
  // description for genuinely sparse text), so describing them would be a wasted
  // call. Pass 7's tabular gate restructures those pages instead.
  const sparsePages = pages.filter((p) => !p.hasImages && p.text.length < 200);

  // Load any descriptions already written in a previous (interrupted) run so we
  // can skip those pages and resume from where processing stalled.
  const existingRows = await db
    .select({ pageNumber: manualPagesTable.pageNumber, description: manualPagesTable.description })
    .from(manualPagesTable)
    .where(and(eq(manualPagesTable.manualId, manualId), isNotNull(manualPagesTable.description)));
  const existingDescriptions = new Map(existingRows.map((r) => [r.pageNumber, r.description!]));

  // Describe all qualifying sparse pages (no cap — full document coverage)
  const toDescribe = sparsePages;
  const resuming = existingDescriptions.size > 0;
  const remaining = toDescribe.filter((p) => !existingDescriptions.has(p.pageNumber));

  // Return a map of pageNumber → description so the caller can patch pdfContent
  // in-memory before Pass 7 runs, ensuring FTS chunks contain enriched text.
  const generated = new Map<number, string>(existingDescriptions);

  if (resuming) {
    await setActivity(manualId, `Pass 3 — resuming: ${existingDescriptions.size} pages already done, ${remaining.length} remaining`);
  }

  for (let i = 0; i < remaining.length; i++) {
    const page = remaining[i]!;
    if (i % 10 === 0) {
      await setActivity(manualId, `Pass 3 — describing sparse page ${page.pageNumber} (${i + 1} of ${remaining.length} remaining)`);
    }
    try {
      const context = fullText.slice(
        Math.max(0, page.pageNumber * 500 - 1000),
        page.pageNumber * 500 + 1000
      );

      const response = await openai.chat.completions.create({
        model: MODEL,
        max_completion_tokens: 1024,
        messages: [
          {
            role: "system",
            content: `You are analyzing a page from an engineering manual. Based on the available text and context, describe what this page likely contains (diagrams, schematics, tables, charts, etc.) and what technical information it conveys. Be specific and technical.`,
          },
          {
            role: "user",
            content: `Page ${page.pageNumber} text: "${page.text.slice(0, 500)}"\n\nContext from surrounding pages: "${context.slice(0, 500)}"\n\nDescribe this page's content and any diagrams, tables, or images it likely contains.`,
          },
        ],
      });

      const description = response.choices[0]?.message?.content ?? "";

      await db
        .update(manualPagesTable)
        .set({ description })
        .where(
          and(
            eq(manualPagesTable.manualId, manualId),
            eq(manualPagesTable.pageNumber, page.pageNumber)
          )
        );

      if (description) generated.set(page.pageNumber, description);
    } catch (err) {
      logger.warn({ err, page: page.pageNumber }, "Vision pass failed for page");
    }
  }

  return generated;
}

// ─── PASS 4: Entity extraction ──────────────────────────────────────────────

interface EntityAttribute {
  value: string;
  unit?: string;
  tolerance?: string;
  applicableTo?: string;
}

interface EntityProperties {
  attributes?: EntityAttribute[];
  conditions?: string[];
  applicableTo?: string[];
}

interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
  pageReferences: number[];
  orderIndex?: number;
  properties?: EntityProperties;
}

async function pass4EntityExtraction(
  manualId: number,
  fullText: string,
  documentType: string,
  overview: string,
  maxChunks = Infinity,
  knownMachines: string[] = []
): Promise<ExtractedEntity[]> {
  await updateManualPass(manualId, 4);

  const allEntities: ExtractedEntity[] = [];
  const chunks = chunkText(fullText, 3000);
  const seenNames = new Set<string>();

  // Anchor naming to the top-level machines Pass 1 identified, so the same machine
  // is named identically across every chunk (chat domain classification matches on
  // exact entity names — naming drift fragments retrieval).
  const machineAnchor = knownMachines.length > 0
    ? `\n\nKNOWN TOP-LEVEL MACHINES (use these EXACT names when referring to them; keep naming consistent across the document):\n${knownMachines.map((m) => `- ${m}`).join("\n")}`
    : "";

  const totalEntityChunks = Math.min(chunks.length, maxChunks === Infinity ? chunks.length : maxChunks);
  for (let ci = 0; ci < totalEntityChunks; ci++) {
    const chunk = chunks[ci];
    await setActivity(manualId, `Pass 4 — extracting entities, chunk ${ci + 1} of ${totalEntityChunks}`);
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        max_completion_tokens: MAX_TOKENS,
        messages: [
          {
            role: "system",
            content: `You are an expert at extracting structured knowledge from engineering manuals.
Document type: ${documentType}
Document overview: ${overview}

Extract ALL distinct entities from the text. Return a JSON object with an "entities" array.
Each entity must have:
- name: precise technical name (e.g. "Main Drive Motor", "Hydraulic Pump Unit", "Control Panel")
- type: one of: machine, component, subsystem, process, part, material, sensor, system, assembly, document_section
- description: 1-2 technical sentences explaining what this entity is and its function
- pageReferences: array of page numbers where this entity is mentioned (estimate based on context)
- orderIndex: integer indicating order/position in the document (use chunk offset: ${ci * 100})
- properties: optional object containing structured facts about this entity:
    - attributes: array of { value, unit, tolerance, applicableTo } — ALL specific measured values or specifications for this entity. If the same measurement has DIFFERENT values for different machine types/variants, list EACH as a separate attribute with "applicableTo" set to the machine type. Example: [{ "value": "250", "unit": "mm", "tolerance": "±1", "applicableTo": "TBA 750 S" }, { "value": "300", "unit": "mm", "tolerance": "±1", "applicableTo": "Sq machines" }]
    - conditions: array of strings — ANY scope qualifiers that limit when/where this entity or its values apply. Copy the EXACT wording from the text (e.g. "Valid only for Sq machines", "Not valid for ReverseFin (LH outfeed)", "For MM edition 06"). These are critical for correctness.
    - applicableTo: array of strings — which specific machine models, variants, or editions this entity applies to (e.g. ["TBA 750 S", "TBA 750 B"]) or ["all machines"] if universally applicable

Guidelines:
- machine: top-level equipment or device (e.g. "Hydraulic Press", "CNC Lathe")
- system: major functional system (e.g. "Hydraulic System", "Electrical System", "Cooling System")
- subsystem: part of a system (e.g. "Pump Assembly", "Control Circuit")
- assembly: mechanical assembly (e.g. "Bearing Assembly", "Valve Block")
- component: individual components (e.g. "Pressure Valve", "Motor Controller")
- part: a specific part (e.g. "O-Ring", "Bolt M8", "Filter Element")
- sensor: measurement devices (e.g. "Pressure Sensor", "Temperature Transducer")
- process: operational processes (e.g. "Startup Sequence", "Maintenance Procedure", "Lubrication Cycle")
- material: materials used (e.g. "Hydraulic Oil ISO 46", "Steel Grade S355")
- document_section: major manual sections

Be precise — use the exact names from the text. Do not invent entities not in the text.
IMPORTANT: For measurement entities (distances, pressures, temperatures, tensions), always populate "properties.attributes" with all variant values and "properties.conditions" with any scope qualifiers present in the text.${machineAnchor}`,
          },
          {
            role: "user",
            content: `Extract all entities from this section of the engineering manual:\n\n${chunk}`,
          },
        ],
        response_format: { type: "json_object" },
      });

      const raw = response.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(raw);
      const entities: ExtractedEntity[] = parsed.entities ?? [];

      for (const entity of entities) {
        const normalizedName = entity.name?.toLowerCase().trim();
        if (normalizedName && !seenNames.has(normalizedName) && entity.name && entity.type) {
          seenNames.add(normalizedName);
          allEntities.push(entity);
        }
      }
    } catch (err) {
      logger.warn({ err, chunk: ci }, "Entity extraction failed for chunk");
    }
  }

  return allEntities;
}

// ─── PASS 5b: Path extraction ────────────────────────────────────────────────
// Extracts ordered procedural sequences with explicit scope conditions.
// Each path captures a distinct sub-procedure (e.g. "fine-set distance C for
// non-Sq machines") as a discrete, queryable record so competing facts from
// different machine-type branches never collapse into the same retrieval unit.

interface ExtractedPath {
  name: string;
  pathType: string;
  condition?: string;
  stepSequence: string[];
  plainLanguage: string;
  pageReferences: number[];
}

async function pass5ExtractPaths(
  manualId: number,
  fullText: string,
  maxChunks = Infinity,
  entities: ExtractedEntity[] = []
): Promise<ExtractedPath[]> {
  const allPaths: ExtractedPath[] = [];
  const chunks = chunkText(fullText, 4000);

  // Build a compact entity reference list so the model can anchor step descriptions
  // to the exact entity names already extracted in Pass 4, ensuring consistency.
  const entityRef = entities.length > 0
    ? `\n\nKNOWN ENTITIES (use these exact names in stepSequence where applicable):\n${entities.map((e) => `- ${e.name} (${e.type})`).join("\n")}`
    : "";

  const totalPathChunks = Math.min(chunks.length, maxChunks === Infinity ? chunks.length : maxChunks);
  for (let ci = 0; ci < totalPathChunks; ci++) {
    const chunk = chunks[ci];
    await setActivity(manualId, `Pass 5b — extracting procedures, chunk ${ci + 1} of ${totalPathChunks}`);
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        max_completion_tokens: MAX_TOKENS,
        messages: [
          {
            role: "system",
            content: `You are an expert at extracting procedural knowledge from engineering manuals.

Extract ALL ordered procedural sequences from the text. These are:
- Lettered or numbered procedure steps (a), b), c)... or 1. 2. 3.)
- Fine-setting / basic-setting procedures for measurements or adjustments
- Assembly or disassembly sequences
- Any instruction with a defined order and an outcome

For each path, return:
- name: short unique name (e.g. "Fine setting distance C - non-Sq machines", "Basic setting distance D - Sq machines")
- pathType: one of "procedure_step", "assembly_sequence", "decision_flow", "measurement_setting"
- condition: EXACT text of any scope qualifier that limits when this path applies (e.g. "Not valid for Sq machines", "Valid only for Sq machines", "For MM edition 06"). Leave null if it applies to all machines/conditions.
- stepSequence: ordered array of concise step descriptions. Where a step involves a known entity, use its exact name from the KNOWN ENTITIES list.
- plainLanguage: single sentence summary of what this path achieves. IMPORTANT: if the procedure targets a specific measurement or setting value (e.g. "C = 300 ±1 mm", "tension 30-50 N"), you MUST include that target value explicitly in plainLanguage (e.g. "Sets distance C to 300 ±1 mm on Sq machines by adjusting timing belt pulley (22).").
- pageReferences: array of page numbers (estimate from context)

Return a JSON object with a "paths" array.

CRITICAL: If the text contains two versions of the same procedure for different machine types (e.g. one section "Not valid for Sq machines" and another "Valid only for Sq machines"), extract them as SEPARATE paths with their respective conditions. This is essential for accuracy.${entityRef}`,
          },
          {
            role: "user",
            content: `Extract all procedural paths from this manual section:\n\n${chunk}`,
          },
        ],
        response_format: { type: "json_object" },
      });

      const raw = response.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(raw);
      const paths: ExtractedPath[] = parsed.paths ?? [];
      allPaths.push(...paths);
    } catch (err) {
      logger.warn({ err, chunk: ci }, "Path extraction failed for chunk");
    }
  }

  return allPaths;
}

// ─── PASS 5: Relationship extraction ────────────────────────────────────────

interface ExtractedRelationship {
  sourceName: string;
  targetName: string;
  type: string;
  label: string;
  orderIndex?: number;
}

async function pass5RelationshipExtraction(
  manualId: number,
  fullText: string,
  entities: ExtractedEntity[],
  nameToId: Map<string, number>,
  maxChunks = Infinity
): Promise<number> {
  await updateManualPass(manualId, 5);

  const entityNames = entities.map((e) => e.name).join(", ");
  let relCount = 0;
  const chunks = chunkText(fullText, 4000);

  const totalRelChunks = Math.min(chunks.length, maxChunks === Infinity ? chunks.length : maxChunks);
  for (let ci = 0; ci < totalRelChunks; ci++) {
    const chunk = chunks[ci];
    await setActivity(manualId, `Pass 5 — mapping relationships, chunk ${ci + 1} of ${totalRelChunks}`);
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        max_completion_tokens: MAX_TOKENS,
        messages: [
          {
            role: "system",
            content: `You are an expert at extracting relationships between engineering components from technical manuals.

Known entities: ${entityNames}

Extract all relationships between these entities from the text.
Return a JSON object with a "relationships" array.
Each relationship must have:
- sourceName: exact name of the source entity (must match a known entity name)
- targetName: exact name of the target entity (must match a known entity name)  
- type: one of: contains, part_of, connects_to, depends_on, sequence, communicates_with, powers, controls, feeds_into, mounted_on
- label: brief description of the relationship (e.g. "drives rotation", "regulates pressure", "Step 2 follows Step 1")
- orderIndex: integer for sequence ordering (use ${ci * 100} as offset)

Relationship types:
- contains: A contains B as a subcomponent
- part_of: A is a part of B (opposite of contains)
- connects_to: A physically or electrically connects to B
- depends_on: A depends on B to function
- sequence: A comes before B in a process/procedure
- communicates_with: A sends signals/data to B
- powers: A provides power to B
- controls: A controls or regulates B
- feeds_into: A feeds material/fluid into B
- mounted_on: A is physically mounted on B

Only use entity names that exactly match (or very closely match) the known entities list.`,
          },
          {
            role: "user",
            content: `Extract relationships between the known entities from this manual section:\n\n${chunk}`,
          },
        ],
        response_format: { type: "json_object" },
      });

      const raw = response.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(raw);
      const relationships: ExtractedRelationship[] = parsed.relationships ?? [];
      // Insert immediately so a crash only loses the current chunk, not all previous work
      for (const rel of relationships) {
        const sourceId = nameToId.get(rel.sourceName?.toLowerCase().trim() ?? "");
        const targetId = nameToId.get(rel.targetName?.toLowerCase().trim() ?? "");
        if (!sourceId || !targetId || sourceId === targetId) continue;
        try {
          await db.insert(relationshipsTable).values({
            manualId,
            sourceEntityId: sourceId,
            targetEntityId: targetId,
            type: rel.type ?? "connects_to",
            label: rel.label ?? "",
            orderIndex: rel.orderIndex ?? null,
            properties: null,
          });
          relCount++;
        } catch (err) {
          logger.warn({ err }, "Relationship insert failed");
        }
      }
    } catch (err) {
      logger.warn({ err, chunk: ci }, "Relationship extraction failed for chunk");
    }
  }

  return relCount;
}

// ─── PASS 6: Ordering & hierarchy ───────────────────────────────────────────

async function pass6OrderingHierarchy(
  manualId: number,
  fullText: string,
  entities: ExtractedEntity[],
  knownMachines: string[] = []
): Promise<{ hierarchyNotes: string; topLevelMachines: string[]; procedureOrder: string[] }> {
  await updateManualPass(manualId, 6);

  // Seed with the top-level machines Pass 1 already identified so the model
  // ranks a known list rather than re-deriving it from scratch.
  const machineSeed = knownMachines.length > 0
    ? `\n\nTop-level machines already identified (rank/refine these, do not invent new ones unless clearly missing): ${knownMachines.join(", ")}`
    : "";

  // Extract top-level hierarchy from overview section
  const sample = fullText.slice(0, 4000);
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 2048,
      messages: [
        {
          role: "system",
          content: `You are analyzing an engineering manual to determine the hierarchy and ordering of components.
Return a JSON object with:
- topLevelMachines: array of top-level machine/system names (ordered by importance)
- procedureOrder: array of procedure/process names in the order they should be executed
- hierarchyNotes: brief notes on the overall system hierarchy`,
        },
        {
          role: "user",
          content: `Determine the hierarchy and ordering from this engineering manual:\n\n${sample}\n\nKnown entities: ${entities.slice(0, 30).map((e) => e.name).join(", ")}${machineSeed}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw);
    return {
      hierarchyNotes: parsed.hierarchyNotes ?? "",
      topLevelMachines: Array.isArray(parsed.topLevelMachines) ? parsed.topLevelMachines : [],
      procedureOrder: Array.isArray(parsed.procedureOrder) ? parsed.procedureOrder : [],
    };
  } catch {
    return { hierarchyNotes: "", topLevelMachines: [], procedureOrder: [] };
  }
}

// Apply Pass 6's top-level machine ranking to entity orderIndex. Ranked machines
// get a distinct low band (negative) so they always sort ahead of chunk-derived
// entities while preserving their relative rank order.
async function applyTopLevelOrdering(manualId: number, topLevelMachines: string[]): Promise<void> {
  for (let i = 0; i < topLevelMachines.length; i++) {
    const name = topLevelMachines[i]?.toLowerCase().trim();
    if (!name) continue;
    try {
      await db
        .update(entitiesTable)
        .set({ orderIndex: -10000 + i })
        .where(
          and(
            eq(entitiesTable.manualId, manualId),
            sql`lower(${entitiesTable.name}) = ${name}`
          )
        );
    } catch (err) {
      logger.warn({ err, manualId, name }, "Top-level ordering update failed");
    }
  }
}

// ─── PASS 7: Chunk text for RAG (stored with auto-generated FTS vector) ──────
//
// Uses chunkPageSemantically() — see pdfExtractor.ts for the full rationale.
// Each page is split at alphabetic step markers (e.g. a), b), f), g)) with
// validity-scope labels prepended to every chunk, so machine-type discriminators
// ("Valid only for Sq machines") always travel with their values tables.
//
// Tabular OCR pages (wiring tables, pin assignments, parts lists) are
// pre-processed by restructureTabularContent() before chunking.  This step
// reconstructs the row-level relationships destroyed when OCR linearises a
// multi-column table into disconnected lists.

/**
 * Detects pages that appear to be OCR-linearised schematic tables or wiring
 * diagrams.  Signal: ≥65% of non-empty lines are very short (< 25 chars) AND
 * the page has ≥ 20 lines total.  Normal prose pages have long lines; schematic
 * annotation pages have one token per line.
 */
function isTabularOcrPage(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 20) return false;
  const shortLines = lines.filter((l) => l.length > 0 && l.length < 25);
  return shortLines.length / lines.length > 0.65;
}

/**
 * Calls GPT to reconstruct relational meaning from OCR-linearised tabular pages.
 *
 * Problem: a wiring table encodes relationships spatially (each table row pairs
 * a pin number with a signal name and wire colour).  OCR reads columns
 * sequentially, so the pairing is lost.  This function asks the model to
 * identify co-located items and write each relationship explicitly, e.g.:
 *   "Pin 1: AM+, Black wire"
 *   "Output Q1:01 → TOP BAR DOWN VALVE (via SSR)"
 *
 * Falls back to the original text on any error so rechunking always completes.
 */
async function restructureTabularContent(rawText: string): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 2000,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `You are a technical document analyst specialising in engineering schematics and wiring diagrams. You receive OCR text from a page that was originally a multi-column table, wiring diagram, or parts list. OCR has linearised it, so spatially related items (e.g. a pin number and its signal name in the same row) appear as separate lines in a disconnected order.

Reconstruct the relational structure. Identify groups of related data and write each relationship as a clear, self-contained statement. Examples:
- "Pin 1: AM+ signal, Black wire"
- "Pin 2: AM- signal, White/Black wire"
- "Output Q1:01 controls TOP BAR DOWN VALVE"
- "Part 9688 SE-1/2-B: Quick Exhaust Valve, Festo, qty 3"
- "Cylinder DSBC-50-80-T-PPVA-N3T1: connected to QST-5/16-12 fittings (190589)"
- "Thermocouple IN 0+/IN 0-: TOP BAR, Type J, Red/White wires"

Rules:
- Preserve ALL identifiers, part numbers, catalogue codes, pin numbers, and wire colours EXACTLY as written — do not normalise, abbreviate or correct them
- Do not fabricate or infer data not present in the source text
- Do not omit any data item present in the source
- Ignore pure diagram grid coordinates (single letters A-H, standalone digits 0-4) that carry no data meaning
- Output only the reconstructed relational statements, one per line, no commentary`,
        },
        {
          role: "user",
          content: `Reconstruct the relational structure from this OCR-linearised schematic page:\n\n${rawText.slice(0, 3500)}`,
        },
      ],
    });
    const result = response.choices[0]?.message?.content?.trim();
    if (!result || result.length < 20) return rawText;
    return result;
  } catch (err) {
    logger.warn({ err }, "Table restructuring failed, using original text");
    return rawText;
  }
}

/**
 * Sends a single page image to GPT-4o with the full ISO/IEC-guided prompt and
 * returns the structured description.  Used in Pass 7 to replace garbled OCR
 * on pages whose embedded images are detected as diagrams/schematics.
 *
 * Returns null on any error so the caller can fall back to the original text.
 */
async function describePageWithVision(
  pdfPath: string,
  pageNumber: number
): Promise<string | null> {
  try {
    const base64Image = await renderPdfPageToBase64FromPath(pdfPath, pageNumber);
    const response = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${base64Image}`, detail: "high" },
            },
            {
              type: "text",
              text: buildPageInterpretationPrompt(pageNumber),
            },
          ],
        },
      ],
    });
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    if (!text || text === "[diagram only]" || text.length < 30) return null;
    return text;
  } catch (err) {
    logger.warn({ err, pageNumber }, "Pass 7: vision description failed, keeping OCR text");
    return null;
  }
}

async function pass7EmbedChunks(
  manualId: number,
  pages: Array<{ pageNumber: number; text: string }>,
  pdfBuffer?: Buffer,
  options: { updatePass?: boolean } = {}
): Promise<void> {
  if (options.updatePass !== false) await updateManualPass(manualId, 7);

  // Check which pages already have chunks so we can resume instead of starting over.
  // If NO chunks exist at all, do the traditional full clear-and-replace to ensure
  // a clean state (handles the case where a previous run wrote partial bad data).
  const existingChunkRows = await db
    .select({ pageNumber: chunksTable.pageNumber })
    .from(chunksTable)
    .where(eq(chunksTable.manualId, manualId));
  const chunkedPageSet = new Set(existingChunkRows.map((r) => r.pageNumber));

  if (chunkedPageSet.size === 0) {
    // Fresh run — clear any stale data and start clean
    await db.delete(chunksTable).where(eq(chunksTable.manualId, manualId));
  } else {
    // Resuming — keep existing chunks, only process pages not yet indexed
    logger.info({ manualId, alreadyChunked: chunkedPageSet.size, total: pages.length }, "Pass 7: resuming — skipping already-indexed pages");
    await setActivity(manualId, `Pass 7 — resuming: ${chunkedPageSet.size} pages already indexed, processing remaining`);
  }

  // For a partial re-run, delete existing chunks for the selected pages before
  // indexing so that stale chunks from a previous full-doc run don't survive.
  // The resume logic below skips any page already in chunkedPageSet — without
  // this delete, an old chunk would block the fresh OCR text from being indexed.
  // We read the pages list to find which page numbers are in scope; if all
  // pages are being processed (rechunk path), chunkedPageSet=0 handles the clear.
  if (pages.length > 0) {
    const pageNums = pages.map((p) => p.pageNumber);
    const existingForRange = await db
      .select({ pageNumber: chunksTable.pageNumber })
      .from(chunksTable)
      .where(eq(chunksTable.manualId, manualId));
    const existingInRange = existingForRange.filter((r) => pageNums.includes(r.pageNumber));
    if (existingInRange.length > 0 && existingInRange.length < existingForRange.length) {
      // Partial overlap — only delete chunks for the pages we're about to re-index
      for (const { pageNumber } of existingInRange) {
        await db.delete(chunksTable).where(
          and(eq(chunksTable.manualId, manualId), eq(chunksTable.pageNumber, pageNumber))
        );
      }
      logger.info({ manualId, deleted: existingInRange.length }, "Pass 7: deleted stale chunks for re-indexed pages");
    }
  }

  // Pre-write the PDF buffer to a single shared temp file (if provided) so the
  // diagram gate can call pdfimages/pdftoppm without re-writing the buffer on
  // every page.  Also restrict the diagram gate to pages with embedded images
  // (detected during Pass 2) so text-only pages skip pixel analysis entirely.
  // Both together reduce temp-disk I/O from O(pages × fileSize) to O(fileSize).
  let sharedPdfPath: string | undefined;
  let cleanupSharedPdf: (() => Promise<void>) | undefined;
  let imagePageNumbers: Set<number> | undefined;
  if (pdfBuffer) {
    ({ pdfPath: sharedPdfPath, cleanup: cleanupSharedPdf } = await writePdfToTempFile(pdfBuffer));
    const imageRows = await db
      .select({ pageNumber: manualPagesTable.pageNumber })
      .from(manualPagesTable)
      .where(and(eq(manualPagesTable.manualId, manualId), eq(manualPagesTable.hasImages, 1)));
    imagePageNumbers = new Set(imageRows.map((r) => r.pageNumber));
    logger.info(
      { manualId, imagePages: imagePageNumbers.size },
      "Pass 7: diagram gate restricted to pages with embedded images"
    );
  }

  let totalChunks = 0;
  let restructuredPages = 0;
  let diagramPages = 0;
  let pass7PageIdx = 0;
  for (const page of pages) {
    pass7PageIdx++;
    // Skip pages already indexed in a previous run
    if (chunkedPageSet.has(page.pageNumber)) continue;
    if (pass7PageIdx % 20 === 1) {
      await setActivity(manualId, `Pass 7 — indexing page ${page.pageNumber} of ${pages.length} for search`);
    }
    // For pages with very little extracted text, still attempt vision enrichment if
    // the page has embedded images — the procedure text may be inside the illustration
    // (e.g. installation/lubrication pages where pdf-parse yields < 20 chars but the
    // page contains numbered steps alongside diagrams).  Only skip outright if there
    // is no image data to fall back on.
    const isShortText = !page.text || page.text.trim().length < 20;
    const hasEmbeddedImages = imagePageNumbers?.has(page.pageNumber) ?? false;
    if (isShortText && (!hasEmbeddedImages || !sharedPdfPath)) continue;

    let textToChunk = page.text ?? "";
    let enriched = false;

    // Diagram gate: only runs on pages that have embedded images (Pass 2 flag),
    // using a pre-written shared PDF path to avoid re-writing the buffer each page.
    if (sharedPdfPath && imagePageNumbers?.has(page.pageNumber) && await hasDiagramImageFromPath(sharedPdfPath, page.pageNumber)) {
      const visionText = await describePageWithVision(sharedPdfPath, page.pageNumber);
      if (visionText) {
        // Combine vision description (structured drawing metadata) with the
        // original OCR text so FTS can match BOTH the diagram annotations AND
        // the surrounding procedural sentences. Replacing OCR with vision alone
        // strips searchable keywords that only appear in the prose (e.g.
        // "spring stroke", "minimum clearance") and breaks RAG retrieval.
        const rawOcr = (page.text ?? "").trim();
        textToChunk = rawOcr.length > 50
          ? `${visionText}\n\n${rawOcr}`
          : visionText;
        enriched = true;
        diagramPages++;
        logger.info(
          { manualId, pageNumber: page.pageNumber },
          "Pass 7: diagram page enriched with vision description + OCR"
        );
      } else if (isShortText) {
        // Vision returned nothing and there's no useful text — skip
        continue;
      }
    } else if (isShortText) {
      // No embedded images and text too short — skip
      continue;
    } else if (isTabularOcrPage(page.text)) {
      // Pre-process tabular/schematic pages: reconstruct the row-level
      // relationships that OCR linearisation destroyed.  Prose pages pass through
      // unchanged (isTabularOcrPage returns false for them).
      textToChunk = await restructureTabularContent(page.text);
      enriched = true;
      restructuredPages++;
      logger.info(
        { manualId, pageNumber: page.pageNumber },
        "Pass 7: tabular page restructured"
      );
    }

    // Persist enriched text to the page's description so entity/relationship
    // extraction (which reads manual_pages and prefers description for sparse
    // pages) sees the vision/restructured content rather than the garbled OCR.
    if (enriched && textToChunk.trim().length > 0) {
      try {
        await db
          .update(manualPagesTable)
          .set({ description: sanitizeText(textToChunk) })
          .where(
            and(
              eq(manualPagesTable.manualId, manualId),
              eq(manualPagesTable.pageNumber, page.pageNumber)
            )
          );
      } catch (err) {
        logger.warn(
          { err, manualId, pageNumber: page.pageNumber },
          "Pass 7: description writeback failed"
        );
      }
    }

    const semanticChunks = chunkPageSemantically(textToChunk);

    for (let ci = 0; ci < semanticChunks.length; ci++) {
      const content = sanitizeText(semanticChunks[ci]!.trim());
      if (content.length < 15) continue;

      try {
        await db.insert(chunksTable).values({
          manualId,
          pageNumber: page.pageNumber,
          chunkIndex: ci,
          content,
        });
        totalChunks++;
      } catch (err) {
        logger.warn(
          { err, manualId, pageNumber: page.pageNumber, chunkIndex: ci },
          "Chunk insert failed"
        );
      }
    }
  }

  logger.info({ manualId, totalChunks, restructuredPages, diagramPages }, "Pass 7: semantic chunks stored");
  await cleanupSharedPdf?.();
}

// ─── VISION OCR: ISO/IEC-guided page interpretation ──────────────────────────
//
// Replaces naive "transcribe text" with a classify-then-interpret approach.
// GPT-4o first identifies the page type, then applies the relevant ISO/IEC
// standard to produce semantically rich output (counts, topology, flow paths)
// rather than a flat repetition of visible labels.
//
// Supported page types and governing standards:
//   PNEUMATIC_SCHEMATIC  — ISO 1219-1/2 (fluid power graphical symbols)
//   HYDRAULIC_SCHEMATIC  — ISO 1219-1/2
//   ELECTRICAL_WIRING    — IEC 60617 (graphical symbols for diagrams)
//   PLC_IO_TABLE         — IEC 61131-3 (PLC I/O addressing)
//   MECHANICAL_DRAWING   — ISO 128 (technical drawings / projections)
//   TEXT_TABLE           — plain text, tables, or mixed procedural content

function buildPageInterpretationPrompt(pageNumber: number): string {
  return `You are an expert engineering document analyst trained in ISO and IEC technical standards.

This is page ${pageNumber} of an engineering manual.

STEP 1 — Classify the page. Output exactly one of these labels on the first line:
  PAGE_TYPE: PNEUMATIC_SCHEMATIC
  PAGE_TYPE: HYDRAULIC_SCHEMATIC
  PAGE_TYPE: ELECTRICAL_WIRING
  PAGE_TYPE: PLC_IO_TABLE
  PAGE_TYPE: MECHANICAL_DRAWING
  PAGE_TYPE: TEXT_TABLE

STEP 2 — Interpret the page according to the relevant standard. Follow the rules for the type you identified:

━━━ PNEUMATIC_SCHEMATIC or HYDRAULIC_SCHEMATIC (ISO 1219-1/2) ━━━
Output the following sections:
ACTUATORS:
  For each cylinder or motor symbol: part number / model, bore × stroke (if labelled), quantity of that component visible in the circuit. Example: "DSNU-32-80-PPV-A — 32mm bore, 80mm stroke — QTY: 3"

DIRECTIONAL CONTROL VALVES (DCVs):
  For each DCV: model, port/position configuration (e.g. 5/2-way), actuation method (solenoid coil model + part number if shown), PLC output address if labelled.

FLOW CONTROL & CHECK VALVES:
  Model, part number, quantity, and which branch of the circuit they appear in.

PRESSURE / FILTER / REGULATOR (FRL):
  Model and part number if visible.

FITTINGS & CONNECTORS:
  For each fitting type: model, part number, total quantity visible in this circuit.

CIRCUIT FLOW DESCRIPTION:
  Trace the pneumatic/hydraulic flow path from supply inlet to each actuator in plain English. Name each component in sequence. Explicitly state how many actuators a single valve controls.

━━━ ELECTRICAL_WIRING (IEC 60617) ━━━
Output:
POWER RAILS: voltage levels and AC/DC type.
LOADS: each load's label, model, and rating.
SWITCHING ELEMENTS: relays, contactors, switches — model and coil/contact ratings.
CIRCUIT TRACES: for each circuit, describe: power source → switching elements → load, with wire colour and terminal numbers where visible.

━━━ PLC_IO_TABLE (IEC 61131-3) ━━━
Extract every row as a structured record:
  ADDRESS | DESCRIPTION | SENSOR/DEVICE TYPE | CROSS-REF PAGE
Group rows under headings: DIGITAL INPUTS, DIGITAL OUTPUTS, ANALOGUE INPUTS, ANALOGUE OUTPUTS, TEMPERATURE INPUTS, SPARE CHANNELS.
Note the PLC platform/format if identifiable (e.g. Allen-Bradley ControlLogix, Siemens S7).

━━━ MECHANICAL_DRAWING (ISO 128) ━━━
Output:
PART/ASSEMBLY: name and drawing number.
DIMENSIONS: list all labelled dimensions with units and tolerances.
MATERIALS: material specs and surface finish callouts if present.
BOM TABLE: if a parts list is visible, extract every row.

━━━ TEXT_TABLE ━━━
Extract ALL text exactly as it appears. Preserve: numbered/lettered steps, table rows, part labels, measurements with units, warnings, and section headings. Do NOT summarize or paraphrase.

━━━ PARAMETER / SETTINGS TABLE (check for this on EVERY page type) ━━━

After completing the section above, inspect the ENTIRE page — including corners, lower sections, and any inset boxes — for inverter, drive, servo, or motor controller parameter tables.

A parameter table has rows with systematic parameter IDs such as: Pr0–Pr999, #xx.xxx, P.xxx, d.xxx, F.xxx, C.xxx, b.xxx, A.xxx, or any other numbered parameter scheme.

If ANY such table is present, extract it in full:

PARAMETER TABLE:
<inverter/drive label, e.g. "2 INV." or "SP-2403" or "1 INV / A8AP">
PARAM ID | VALUE
PARAM ID | VALUE
(all rows — do not skip, summarise, or truncate any)

Rules:
- Extract ALL rows without exception.
- Preserve parameter IDs and values EXACTLY as printed (dots, leading zeros, letters).
- If multiple columns of parameters appear side-by-side, read left-to-right across each row.
- If multiple drives have separate tables, extract each under its own label.
- If NO parameter table is visible anywhere on the page, output: PARAMETER TABLE: none

━━━ TITLE BLOCK ━━━

If a drawing title block is visible (usually bottom-right), extract:
DRAWING NO: <value>
SHEET S/N: <value>
SHEET NAME: <value>
PAGE REF: <value>

If the page is blank or contains only unlabelled artwork with no text, output exactly: [diagram only]`;
}

async function passVisionOcr(
  manualId: number,
  pdfBuffer: Buffer,
  pageNumbers: number[]
): Promise<Array<{ pageNumber: number; text: string }>> {
  const results: Array<{ pageNumber: number; text: string }> = [];
  const CONCURRENCY = 5;
  const totalPages = pageNumbers.length;

  // Load already-OCR'd pages from DB (only for the requested pages) so we can skip them on resume.
  const existingRows = await db
    .select({ pageNumber: manualPagesTable.pageNumber, rawText: manualPagesTable.rawText })
    .from(manualPagesTable)
    .where(eq(manualPagesTable.manualId, manualId));
  const alreadyOcrd = new Map<number, string>();
  for (const row of existingRows) {
    if (row.rawText && row.rawText.trim().length > 0 && pageNumbers.includes(row.pageNumber)) {
      alreadyOcrd.set(row.pageNumber, row.rawText);
    }
  }
  const skipCount = alreadyOcrd.size;
  if (skipCount > 0) {
    logger.info({ manualId, skipCount, totalPages }, "Vision OCR — skipping already-OCR'd pages");
    // Pre-populate results with existing data
    for (const [pageNumber, text] of alreadyOcrd) {
      results.push({ pageNumber, text });
    }
  }

  // Write the PDF buffer to disk once; all page renders reuse the same path.
  const { pdfPath, cleanup: cleanupPdf } = await writePdfToTempFile(pdfBuffer);

  for (let start = 0; start < pageNumbers.length; start += CONCURRENCY) {
    const batch = pageNumbers.slice(start, start + CONCURRENCY).filter((p) => !alreadyOcrd.has(p));
    if (batch.length === 0) continue;

    const batchResults = await Promise.all(
      batch.map(async (pageNumber) => {
        try {
          const base64Image = await renderPdfPageToBase64FromPath(pdfPath, pageNumber);

          const response = await openai.chat.completions.create({
            model: MODEL,
            max_completion_tokens: 4096,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/png;base64,${base64Image}`,
                      detail: "high",
                    },
                  },
                  {
                    type: "text",
                    text: buildPageInterpretationPrompt(pageNumber),
                  },
                ],
              },
            ],
          });

          const text = response.choices[0]?.message?.content ?? "";
          const cleanedText = text.trim() === "[diagram only]" ? "" : text.trim();
          return { pageNumber, text: cleanedText };
        } catch (err) {
          logger.warn({ err, pageNumber }, "Vision OCR failed for page");
          return { pageNumber, text: "" };
        }
      })
    );

    results.push(...batchResults);
    await setActivity(manualId, `Vision OCR — processed pages ${batch[0]}–${batch[batch.length - 1]} of ${totalPages}`);

    // Persist OCR text to manual_pages immediately so progress is saved
    for (const { pageNumber, text } of batchResults) {
      await db
        .update(manualPagesTable)
        .set({ rawText: sanitizeText(text) })
        .where(
          and(
            eq(manualPagesTable.manualId, manualId),
            eq(manualPagesTable.pageNumber, pageNumber)
          )
        );
    }

    logger.info(
      { manualId, batchStart: batch[0], batchEnd: batch[batch.length - 1] },
      "Vision OCR batch complete"
    );
  }

  await cleanupPdf();
  return results;
}

// ─── REPROCESS WITH VISION: full re-pipeline for image-based PDFs ─────────────

/**
 * Re-runs the full extraction pipeline for a manual that was originally
 * processed as an image-based PDF (empty raw_text).  Reads the PDF from
 * the provided buffer, uses GPT-4o vision to OCR every page, then runs
 * entity/relationship extraction and semantic chunking on the result.
 */
export async function reprocessManualWithVision(
  manualId: number,
  pdfBuffer: Buffer
): Promise<void> {
  try {
    await setManualStatus(manualId, "processing", { processingPass: 0 });

    // Fetch persisted page count and document type
    const [manual] = await db
      .select({ totalPages: manualsTable.totalPages, documentType: manualsTable.documentType })
      .from(manualsTable)
      .where(eq(manualsTable.id, manualId));

    const totalPages = manual?.totalPages ?? 0;
    if (totalPages === 0) throw new Error("Manual has no pages recorded");

    // Clear previous (empty) extraction data
    await db.delete(entitiesTable).where(eq(entitiesTable.manualId, manualId));
    await db.delete(relationshipsTable).where(eq(relationshipsTable.manualId, manualId));
    await db.delete(chunksTable).where(eq(chunksTable.manualId, manualId));

    // Vision OCR — populate rawText for every page
    await updateManualPass(manualId, 2);
    const allPageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);
    const ocrPages = await passVisionOcr(manualId, pdfBuffer, allPageNumbers);
    const fullText = ocrPages.map((p) => p.text).join("\n\n");

    // Pass 1: Document structure (from OCR text)
    const structure = await pass1DocumentStructure(manualId, fullText, totalPages);
    await db
      .update(manualsTable)
      .set({
        documentType: structure.documentType,
        structure: { overview: structure.overview, machines: structure.machines, sections: structure.sections },
        updatedAt: new Date(),
      })
      .where(eq(manualsTable.id, manualId));

    // Pass 4: Entity extraction (full document, anchored to Pass 1 machine names)
    const extractedEntities = await pass4EntityExtraction(
      manualId,
      fullText,
      structure.documentType,
      structure.overview ?? "",
      undefined,
      structure.machines
    );

    const insertedEntities: Array<{ name: string; id: number }> = [];
    for (const entity of extractedEntities) {
      try {
        const [inserted] = await db
          .insert(entitiesTable)
          .values({
            manualId,
            name: entity.name,
            type: entity.type ?? "component",
            description: entity.description ?? "",
            properties: entity.properties ?? null,
            pageReferences: entity.pageReferences ?? [],
            orderIndex: entity.orderIndex ?? null,
          })
          .returning();
        if (inserted) insertedEntities.push({ name: entity.name, id: inserted.id });
      } catch (err) {
        logger.warn({ err, entity: entity.name }, "Entity insert failed");
      }
    }

    // Pass 5: Relationship extraction (saves per-chunk to the DB itself and
    // returns the number of relationships inserted).
    const nameToId = new Map<string, number>();
    for (const e of insertedEntities) nameToId.set(e.name.toLowerCase().trim(), e.id);

    await pass5RelationshipExtraction(
      manualId,
      fullText,
      extractedEntities,
      nameToId
    );

    // Pass 5b: Path extraction — ordered procedural sequences (entity-anchored)
    const extractedPaths = await pass5ExtractPaths(manualId, fullText, undefined, extractedEntities);
    for (const path of extractedPaths) {
      if (!path.name || !path.plainLanguage) continue;
      try {
        await db.insert(pathsTable).values({
          manualId,
          name: path.name,
          pathType: path.pathType ?? "procedure_step",
          condition: path.condition ?? null,
          stepSequence: path.stepSequence ?? [],
          plainLanguage: path.plainLanguage,
          pageReferences: path.pageReferences ?? [],
        });
      } catch (err) {
        logger.warn({ err, path: path.name }, "Path insert failed (vision reprocess)");
      }
    }

    // Pass 6: Ordering & hierarchy — apply top-level machine ranking to entities
    const hierarchy = await pass6OrderingHierarchy(manualId, fullText, extractedEntities, structure.machines);
    await applyTopLevelOrdering(manualId, hierarchy.topLevelMachines);

    // Pass 7: Semantic chunking
    await pass7EmbedChunks(
      manualId,
      ocrPages.map((p) => ({ pageNumber: p.pageNumber, text: p.text }))
    );

    await setManualStatus(manualId, "completed", { processingPass: 7 });
    logger.info({ manualId, paths: extractedPaths.length }, "Vision reprocess completed");
  } catch (err) {
    await setManualStatus(manualId, "failed", {
      errorMessage: err instanceof Error ? err.message : "Unknown error",
    });
    logger.error({ err, manualId }, "Vision reprocess failed");
    throw err;
  }
}

// ─── TARGETED PAGE OCR: vision-extract and rechunk a page range ──────────────

/**
 * Vision-OCR only a specific range of pages, update their rawText and chunks,
 * without touching the rest of the manual's data.
 */
export async function reprocessPageRangeWithVision(
  manualId: number,
  pdfBuffer: Buffer,
  startPage: number,
  endPage: number
): Promise<{ pages: number; chunks: number }> {
  const clampedEnd = Math.max(startPage, endPage);
  const totalToProcess = clampedEnd - startPage + 1;
  logger.info({ manualId, startPage, endPage: clampedEnd }, "Vision OCR page-range reprocess started");

  const ocrPages: Array<{ pageNumber: number; text: string }> = [];
  const CONCURRENCY = 5;

  // Write the PDF buffer to disk once; all page renders reuse the same path.
  const { pdfPath, cleanup: cleanupPdf } = await writePdfToTempFile(pdfBuffer);

  for (let batch_start = startPage; batch_start <= clampedEnd; batch_start += CONCURRENCY) {
    const batch: number[] = [];
    for (let p = batch_start; p < batch_start + CONCURRENCY && p <= clampedEnd; p++) {
      batch.push(p);
    }

    const batchResults = await Promise.all(
      batch.map(async (pageNumber) => {
        try {
          const base64Image = await renderPdfPageToBase64FromPath(pdfPath, pageNumber);
          const response = await openai.chat.completions.create({
            model: MODEL,
            max_completion_tokens: 4096,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/png;base64,${base64Image}`,
                      detail: "high",
                    },
                  },
                  {
                    type: "text",
                    text: buildPageInterpretationPrompt(pageNumber),
                  },
                ],
              },
            ],
          });
          const text = response.choices[0]?.message?.content ?? "";
          const cleanedText = text.trim() === "[diagram only]" ? "" : text.trim();
          return { pageNumber, text: cleanedText };
        } catch (err) {
          logger.warn({ err, pageNumber }, "Vision OCR failed for page");
          return { pageNumber, text: "" };
        }
      })
    );

    ocrPages.push(...batchResults);

    for (const { pageNumber, text } of batchResults) {
      await db
        .update(manualPagesTable)
        .set({ rawText: sanitizeText(text) })
        .where(
          and(
            eq(manualPagesTable.manualId, manualId),
            eq(manualPagesTable.pageNumber, pageNumber)
          )
        );
    }
  }

  // Delete only the chunks for this page range, then re-insert
  for (const { pageNumber, text } of ocrPages) {
    await db
      .delete(chunksTable)
      .where(
        and(
          eq(chunksTable.manualId, manualId),
          eq(chunksTable.pageNumber, pageNumber)
        )
      );

    if (!text || text.trim().length < 20) continue;
    const semanticChunks = chunkPageSemantically(text);
    for (let ci = 0; ci < semanticChunks.length; ci++) {
      const content = semanticChunks[ci]!.trim();
      if (content.length < 15) continue;
      try {
        await db.insert(chunksTable).values({ manualId, pageNumber, chunkIndex: ci, content });
      } catch (err) {
        logger.warn({ err, pageNumber, ci }, "Chunk insert failed");
      }
    }
  }

  // Count newly created chunks for the processed range
  let totalChunks = 0;
  for (const { pageNumber } of ocrPages) {
    const [row] = await db
      .select({ cnt: count() })
      .from(chunksTable)
      .where(and(eq(chunksTable.manualId, manualId), eq(chunksTable.pageNumber, pageNumber)));
    totalChunks += row?.cnt ?? 0;
  }

  logger.info({ manualId, startPage, endPage: clampedEnd, pages: totalToProcess, totalChunks }, "Vision OCR page-range complete");
  await cleanupPdf();
  return { pages: totalToProcess, chunks: totalChunks };
}

// ─── EXTRACT GRAPH: run entity/relationship extraction on existing OCR text ───
//
// Runs passes 1, 4, 5, 6 on whatever rawText is already stored in manual_pages.
// Use this after a page-range OCR to populate the knowledge graph without
// re-running the full pipeline or re-downloading the PDF.

export async function extractGraphFromExistingText(
  manualId: number,
  opts?: { entityChunks?: number; relChunks?: number; startPage?: number; endPage?: number }
): Promise<{ entities: number; relationships: number }> {
  const entityChunks = opts?.entityChunks ?? Infinity;
  const relChunks = opts?.relChunks ?? Infinity;
  const startPage = opts?.startPage;
  const endPage = opts?.endPage;
  // A partial run targets a specific page range — additive, no blanket delete.
  const isPartialRun = startPage !== undefined || endPage !== undefined;

  // ── Capture state BEFORE touching processingPass ─────────────────────────
  // We need to know which passes were already completed before we overwrite
  // processingPass with 4, so we can skip them on resume.
  const [priorState] = await db
    .select({ processingPass: manualsTable.processingPass, status: manualsTable.status })
    .from(manualsTable)
    .where(eq(manualsTable.id, manualId));
  const previousPass = priorState?.processingPass ?? 0;
  // A "completed" status means the previous run finished successfully — this is
  // a deliberate re-extraction, not a resume.  Treat it as a fresh run so all
  // passes re-execute rather than skipping based on leftover entity counts.
  const previouslyCompleted = priorState?.status === "completed";

  // Count existing entities and relationships so we can decide whether to
  // resume (skip already-complete passes) or restart (delete and redo).
  const [entityCountRow] = await db
    .select({ cnt: count() })
    .from(entitiesTable)
    .where(eq(entitiesTable.manualId, manualId));
  const [relCountRow] = await db
    .select({ cnt: count() })
    .from(relationshipsTable)
    .where(eq(relationshipsTable.manualId, manualId));
  const existingEntityCount = entityCountRow?.cnt ?? 0;
  const existingRelCount = relCountRow?.cnt ?? 0;

  // Resume rules (only apply when truly stalled mid-pass, never on a fresh re-run):
  //  • previousPass >= 5 AND entities exist AND not completed → Pass 4 finished; skip it
  //  • previousPass >= 6 AND rels exist AND not completed     → Pass 5 finished; skip it too
  //  • Otherwise (including status="completed")               → delete and run from scratch
  // For partial page-range runs, resume is disabled — entities from other page
  // ranges already exist in the DB so the counts are meaningless for this range.
  const resumeFromPass5 = !isPartialRun && !previouslyCompleted && previousPass >= 5 && existingEntityCount > 0;
  // resumeFromPass6: skip pass 5 if relationships already exist in DB.
  // Since pass 5 now saves per-chunk, any existing relationships mean we have
  // at least partial (often near-complete) pass 5 data — safe to skip to pass 6.
  const resumeFromPass6 = !isPartialRun && !previouslyCompleted && previousPass >= 5 && existingRelCount > 0;

  await setManualStatus(manualId, "processing", { processingPass: 4 });
  if (resumeFromPass5) {
    await setActivity(manualId, `Resuming — Pass 4 already done (${existingEntityCount} entities found), checking relationships...`);
    logger.info({ manualId, existingEntityCount, previousPass }, "extractGraphFromExistingText: resuming from Pass 5 — entities already extracted");
  } else {
    await setActivity(manualId, "Pass 4 — preparing entity extraction...");
  }

  // Wrap the whole job so any throw releases the manual from "processing".
  // Without this, a failed background run would leave status stuck at "processing"
  // forever — and the route's claim guard would then reject every re-trigger.
  try {
  const [manual] = await db
    .select({ documentType: manualsTable.documentType, structure: manualsTable.structure })
    .from(manualsTable)
    .where(eq(manualsTable.id, manualId));
  if (!manual) throw new Error(`Manual ${manualId} not found`);

  const pages = await db
    .select({
      pageNumber: manualPagesTable.pageNumber,
      rawText: manualPagesTable.rawText,
      description: manualPagesTable.description,
    })
    .from(manualPagesTable)
    .where(
      isPartialRun
        ? and(
            eq(manualPagesTable.manualId, manualId),
            startPage !== undefined ? gte(manualPagesTable.pageNumber, startPage) : undefined,
            endPage   !== undefined ? lte(manualPagesTable.pageNumber, endPage)   : undefined,
          )
        : eq(manualPagesTable.manualId, manualId)
    )
    .orderBy(manualPagesTable.pageNumber);

  // For pages where OCR is sparse but Pass 3 generated a vision description,
  // use the description instead — it captures diagram/table content that OCR misses.
  const fullText = pages
    .map((p) => {
      const raw = (p.rawText ?? "").trim();
      const desc = (p.description ?? "").trim();
      if (raw.length < 100 && desc.length > 0) {
        return `[Page ${p.pageNumber} — diagram/image content]\n${desc}`;
      }
      return raw;
    })
    .filter((t) => t.trim().length > 0)
    .join("\n\n");

  if (fullText.trim().length === 0) {
    throw new Error(`Manual ${manualId} has no OCR text — run vision OCR first`);
  }

  // Clear graph data before extraction.
  // • Whole-document run: delete everything (fresh start or deliberate re-extract).
  // • Partial run: only delete entities/paths that were previously tagged for
  //   this exact page range — entities from other ranges survive untouched.
  //   Relationships self-clean via CASCADE when their entity is deleted.
  if (!resumeFromPass5) {
    if (isPartialRun) {
      await db.delete(entitiesTable).where(
        and(
          eq(entitiesTable.manualId, manualId),
          isNotNull(entitiesTable.extractionStartPage),
          gte(entitiesTable.extractionStartPage, startPage!),
          lte(entitiesTable.extractionEndPage, endPage!),
        )
      );
      await db.delete(pathsTable).where(
        and(
          eq(pathsTable.manualId, manualId),
          isNotNull(pathsTable.extractionStartPage),
          gte(pathsTable.extractionStartPage, startPage!),
          lte(pathsTable.extractionEndPage, endPage!),
        )
      );
    } else {
      await db.delete(entitiesTable).where(eq(entitiesTable.manualId, manualId));
      await db.delete(relationshipsTable).where(eq(relationshipsTable.manualId, manualId));
      await db.delete(pathsTable).where(eq(pathsTable.manualId, manualId));
    }
  }

  // Pass 1: document structure. Reuse the stored structure from the upload pass
  // if present — re-running Pass 1 here would be a wasted LLM call on identical text.
  let structure: { documentType: string; overview: string; machines: string[]; sections: string[] };
  if (manual.structure) {
    structure = {
      documentType: manual.documentType ?? "other",
      overview: manual.structure.overview,
      machines: manual.structure.machines ?? [],
      sections: manual.structure.sections ?? [],
    };
  } else {
    structure = await pass1DocumentStructure(manualId, fullText, pages.length);
    await db
      .update(manualsTable)
      .set({
        documentType: structure.documentType,
        structure: { overview: structure.overview, machines: structure.machines, sections: structure.sections },
        updatedAt: new Date(),
      })
      .where(eq(manualsTable.id, manualId));
  }

  // ── Pass 4: entity extraction ─────────────────────────────────────────────
  // Skip if we are resuming from Pass 5+ (entities already in DB).
  let insertedEntities: Array<{ name: string; id: number }>;
  let extractedEntitiesForContext: ExtractedEntity[];

  if (resumeFromPass5) {
    // Load entities from DB so Pass 5 context (entity name anchoring) stays consistent
    await updateManualPass(manualId, 5);
    const dbEntities = await db
      .select({ id: entitiesTable.id, name: entitiesTable.name, type: entitiesTable.type, description: entitiesTable.description, pageReferences: entitiesTable.pageReferences, properties: entitiesTable.properties })
      .from(entitiesTable)
      .where(eq(entitiesTable.manualId, manualId));
    insertedEntities = dbEntities.map((e) => ({ name: e.name, id: e.id }));
    extractedEntitiesForContext = dbEntities.map((e) => ({
      name: e.name,
      type: e.type,
      description: e.description,
      pageReferences: (e.pageReferences as number[]) ?? [],
      properties: (e.properties as EntityProperties | undefined) ?? undefined,
    }));
    logger.info({ manualId, entities: insertedEntities.length }, "Pass 4: skipped — loaded existing entities from DB");
    await setActivity(manualId, `Pass 4 ✓ — ${insertedEntities.length} entities already extracted, resuming from relationships`);
  } else {
    const extractedEntities = await pass4EntityExtraction(
      manualId,
      fullText,
      structure.documentType,
      structure.overview ?? "",
      entityChunks,
      structure.machines
    );
    extractedEntitiesForContext = extractedEntities;

    insertedEntities = [];
    for (const entity of extractedEntities) {
      try {
        const [inserted] = await db
          .insert(entitiesTable)
          .values({
            manualId,
            name: entity.name,
            type: entity.type ?? "component",
            description: entity.description ?? "",
            properties: entity.properties ?? null,
            pageReferences: entity.pageReferences ?? [],
            orderIndex: entity.orderIndex ?? null,
            extractionStartPage: startPage ?? null,
            extractionEndPage: endPage ?? null,
          })
          .returning();
        if (inserted) insertedEntities.push({ name: entity.name, id: inserted.id });
      } catch (err) {
        logger.warn({ err, entity: entity.name }, "Entity insert failed");
      }
    }
  }

  // ── Pass 5: relationship extraction ──────────────────────────────────────
  // Skip if we are resuming from Pass 6+ (relationships already in DB).
  const nameToId = new Map<string, number>();
  for (const e of insertedEntities) nameToId.set(e.name.toLowerCase().trim(), e.id);

  let relCount = 0;
  if (resumeFromPass6) {
    relCount = existingRelCount;
    await updateManualPass(manualId, 6);
    logger.info({ manualId, relationships: relCount }, "Pass 5: skipped — relationships already in DB");
    await setActivity(manualId, `Pass 5 ✓ — ${relCount} relationships already extracted, resuming from ordering`);
  } else {
    // Clear relationships/paths before (re-)running pass 5.
    // Partial run: entity CASCADE already removed relationships for deleted entities;
    // paths for the range were cleaned up before pass 4. Skip the full-table delete.
    // Whole-doc run: wipe everything as before.
    if (!isPartialRun) {
      await db.delete(relationshipsTable).where(eq(relationshipsTable.manualId, manualId));
      await db.delete(pathsTable).where(eq(pathsTable.manualId, manualId));
    }

    relCount = await pass5RelationshipExtraction(
      manualId,
      fullText,
      extractedEntitiesForContext,
      nameToId,
      relChunks
    );

    // Pass 5b: path extraction — ordered procedural sequences with scope conditions.
    const extractedPaths = await pass5ExtractPaths(manualId, fullText, relChunks, extractedEntitiesForContext);
    let pathCount = 0;
    for (const path of extractedPaths) {
      if (!path.name || !path.plainLanguage) continue;
      try {
        await db.insert(pathsTable).values({
          manualId,
          name: path.name,
          pathType: path.pathType ?? "procedure_step",
          condition: path.condition ?? null,
          stepSequence: path.stepSequence ?? [],
          plainLanguage: path.plainLanguage,
          pageReferences: path.pageReferences ?? [],
          extractionStartPage: startPage ?? null,
          extractionEndPage: endPage ?? null,
        });
        pathCount++;
      } catch (err) {
        logger.warn({ err, path: path.name }, "Path insert failed");
      }
    }
    logger.info({ manualId, paths: pathCount }, "Pass 5b: path extraction complete");
  }

  // Pass 6: ordering & hierarchy — always re-run (lightweight, idempotent UPDATE)
  const hierarchy = await pass6OrderingHierarchy(manualId, fullText, extractedEntitiesForContext, structure.machines);
  await applyTopLevelOrdering(manualId, hierarchy.topLevelMachines);

  await setManualStatus(manualId, "completed", { processingPass: 7 });
  logger.info(
    { manualId, entities: insertedEntities.length, relationships: relCount, entityChunks, relChunks, resumeFromPass5, resumeFromPass6 },
    "Graph extraction from existing text complete"
  );
  return { entities: insertedEntities.length, relationships: relCount };
  } catch (err) {
    logger.error({ err, manualId }, "Graph extraction from existing text failed");
    await setManualStatus(manualId, "failed", {
      errorMessage: err instanceof Error ? err.message : "Unknown error",
    });
    throw err;
  }
}

// ─── REPAIR GRAPH: re-run Passes 5, 5b, and 6 from existing entities/text ────
//
// Use when a manual already has OCR text and entities (processing_pass >= 4)
// but the relationships and paths tables are empty because extraction stalled
// before Pass 5.  Unlike extractGraphFromExistingText this function NEVER
// re-runs Pass 4 — it assumes the entity table is populated and authoritative.

export async function repairGraphPasses(manualId: number): Promise<{ relationships: number; paths: number }> {
  // Validate: manual must have pages and entities already
  const [priorState] = await db
    .select({ processingPass: manualsTable.processingPass, status: manualsTable.status, documentType: manualsTable.documentType, structure: manualsTable.structure })
    .from(manualsTable)
    .where(eq(manualsTable.id, manualId));

  if (!priorState) throw new Error(`Manual ${manualId} not found`);

  const [entityCountRow] = await db
    .select({ cnt: count() })
    .from(entitiesTable)
    .where(eq(entitiesTable.manualId, manualId));
  const entityCount = entityCountRow?.cnt ?? 0;

  const pages = await db
    .select({ pageNumber: manualPagesTable.pageNumber, rawText: manualPagesTable.rawText, description: manualPagesTable.description })
    .from(manualPagesTable)
    .where(eq(manualPagesTable.manualId, manualId))
    .orderBy(manualPagesTable.pageNumber);

  if (pages.length === 0) throw new Error(`Manual ${manualId} has no OCR text — run vision OCR first`);
  if (entityCount === 0) throw new Error(`Manual ${manualId} has no extracted entities — run full extraction first`);

  await setManualStatus(manualId, "processing", { processingPass: 4 });
  await setActivity(manualId, `Repair — loading ${entityCount} existing entities for relationship + path extraction`);

  try {
    const fullText = pages
      .map((p) => {
        const raw = (p.rawText ?? "").trim();
        const desc = (p.description ?? "").trim();
        if (raw.length < 100 && desc.length > 0) return `[Page ${p.pageNumber} — diagram/image content]\n${desc}`;
        return raw;
      })
      .filter((t) => t.trim().length > 0)
      .join("\n\n");

    // Load existing entities for name anchoring in Pass 5
    const dbEntities = await db
      .select({ id: entitiesTable.id, name: entitiesTable.name, type: entitiesTable.type, description: entitiesTable.description, pageReferences: entitiesTable.pageReferences, properties: entitiesTable.properties })
      .from(entitiesTable)
      .where(eq(entitiesTable.manualId, manualId));

    const extractedEntitiesForContext: ExtractedEntity[] = dbEntities.map((e) => ({
      name: e.name,
      type: e.type,
      description: e.description,
      pageReferences: (e.pageReferences as number[]) ?? [],
      properties: (e.properties as EntityProperties | undefined) ?? undefined,
    }));

    const nameToId = new Map<string, number>();
    for (const e of dbEntities) nameToId.set(e.name.toLowerCase().trim(), e.id);

    // Clear existing relationships and paths (fresh extraction)
    await db.delete(relationshipsTable).where(eq(relationshipsTable.manualId, manualId));
    await db.delete(pathsTable).where(eq(pathsTable.manualId, manualId));

    // Pass 5: relationship extraction
    const relCount = await pass5RelationshipExtraction(manualId, fullText, extractedEntitiesForContext, nameToId);

    // Pass 5b: path extraction
    const extractedPaths = await pass5ExtractPaths(manualId, fullText, Infinity, extractedEntitiesForContext);
    let pathCount = 0;
    for (const path of extractedPaths) {
      if (!path.name || !path.plainLanguage) continue;
      try {
        await db.insert(pathsTable).values({
          manualId,
          name: path.name,
          pathType: path.pathType ?? "procedure_step",
          condition: path.condition ?? null,
          stepSequence: path.stepSequence ?? [],
          plainLanguage: path.plainLanguage,
          pageReferences: path.pageReferences ?? [],
        });
        pathCount++;
      } catch (err) {
        logger.warn({ err, path: path.name }, "Repair: path insert failed");
      }
    }
    logger.info({ manualId, paths: pathCount }, "Repair: Pass 5b complete");

    // Pass 6: ordering & hierarchy
    const structure = {
      documentType: priorState.documentType ?? "other",
      overview: (priorState.structure as { overview?: string } | null)?.overview ?? "",
      machines: (priorState.structure as { machines?: string[] } | null)?.machines ?? [],
      sections: (priorState.structure as { sections?: string[] } | null)?.sections ?? [],
    };
    const hierarchy = await pass6OrderingHierarchy(manualId, fullText, extractedEntitiesForContext, structure.machines);
    await applyTopLevelOrdering(manualId, hierarchy.topLevelMachines);

    await setManualStatus(manualId, "completed", { processingPass: 7 });
    logger.info({ manualId, relationships: relCount, paths: pathCount }, "Repair graph passes complete");
    return { relationships: relCount, paths: pathCount };
  } catch (err) {
    logger.error({ err, manualId }, "Repair graph passes failed");
    await setManualStatus(manualId, "failed", { errorMessage: err instanceof Error ? err.message : "Unknown error" });
    throw err;
  }
}

// ─── RECHUNK: re-run Pass 7 from stored page text ────────────────────────────

/**
 * Re-applies the semantic chunker to all stored pages for a manual without
 * re-running the full extraction pipeline.  Useful after upgrading the
 * chunking strategy.
 */
export async function rechunkManual(manualId: number): Promise<{ chunks: number }> {
  const pages = await db
    .select({
      pageNumber: manualPagesTable.pageNumber,
      rawText: manualPagesTable.rawText,
      description: manualPagesTable.description,
    })
    .from(manualPagesTable)
    .where(eq(manualPagesTable.manualId, manualId))
    .orderBy(manualPagesTable.pageNumber);

  if (pages.length === 0) throw new Error(`No pages found for manual ${manualId}`);

  // Delete all existing chunks first — pass7EmbedChunks's resume logic skips
  // any page already in chunkedPageSet, making rechunk a no-op on already-chunked
  // manuals without this explicit clear.
  await db.delete(chunksTable).where(eq(chunksTable.manualId, manualId));
  logger.info({ manualId, pages: pages.length }, "rechunkManual: cleared existing chunks, re-indexing all pages");

  // Prefer the enriched description for sparse pages (mirrors extractGraphFromExistingText)
  // so re-chunking keeps the vision/restructured content instead of thin OCR text.
  await pass7EmbedChunks(
    manualId,
    pages.map((p) => {
      const raw = (p.rawText ?? "").trim();
      const desc = (p.description ?? "").trim();
      return {
        pageNumber: p.pageNumber,
        text: raw.length < 100 && desc.length > 0 ? desc : raw,
      };
    })
  );

  const [row] = await db
    .select({ cnt: count() })
    .from(chunksTable)
    .where(eq(chunksTable.manualId, manualId));

  return { chunks: row?.cnt ?? 0 };
}

// ─── MAIN PIPELINE ──────────────────────────────────────────────────────────

export async function runExtractionPipeline(
  manualId: number,
  pdfBuffer: Buffer,
  opts?: { startPage?: number; endPage?: number }
): Promise<void> {
  try {
    // ── Load existing DB state before changing anything ──────────────────────
    // This lets every pass check what's already been done and skip it, so a
    // stall at any point — Pass 1, 2, 3, Vision OCR, or 7 — resumes from that
    // exact point rather than restarting from the beginning.
    const [existingManual] = await db
      .select({ structure: manualsTable.structure, documentType: manualsTable.documentType, totalPages: manualsTable.totalPages, processingPass: manualsTable.processingPass })
      .from(manualsTable)
      .where(eq(manualsTable.id, manualId));
    const hasStructure = !!(existingManual?.structure && existingManual.totalPages);

    // When resuming, preserve the existing processingPass so the progress bar
    // does not jump backwards. Only reset to 0 on a genuinely fresh run.
    const startingPass = hasStructure ? (existingManual.processingPass ?? 0) : 0;
    await setManualStatus(manualId, "processing", { processingPass: startingPass });
    await setActivity(manualId, hasStructure ? "Resuming pipeline — checking progress..." : "Starting — extracting text from PDF...");

    // Always extract text from the PDF buffer (fast, no AI — just native parsing).
    const pdfContent = await extractPdfText(pdfBuffer);

    // ── Pass 1: Document structure ───────────────────────────────────────────
    // Pass 1 always analyses the full document for structural context, regardless
    // of any page-range the user selected.
    let structure: { documentType: string; overview: string; machines: string[]; sections: string[] };
    if (hasStructure && existingManual.structure) {
      // Already done in a previous run — reuse saved structure, skip LLM call.
      // Do NOT change processingPass here — it would move the progress bar backwards
      // from wherever the pipeline previously stalled, confusing the user.
      structure = {
        documentType: existingManual.documentType ?? "other",
        overview: existingManual.structure.overview,
        machines: existingManual.structure.machines ?? [],
        sections: existingManual.structure.sections ?? [],
      };
      await setActivity(manualId, "Pass 1 ✓ — structure already done, resuming from where pipeline left off...");
      logger.info({ manualId }, "Pass 1: skipping — structure already in DB");
    } else {
      await db
        .update(manualsTable)
        .set({ totalPages: pdfContent.totalPages, updatedAt: new Date() })
        .where(eq(manualsTable.id, manualId));
      structure = await pass1DocumentStructure(manualId, pdfContent.fullText, pdfContent.totalPages);
      await db
        .update(manualsTable)
        .set({
          documentType: structure.documentType,
          structure: { overview: structure.overview, machines: structure.machines, sections: structure.sections },
          updatedAt: new Date(),
        })
        .where(eq(manualsTable.id, manualId));
    }

    // ── Page range filter (applied AFTER Pass 1) ─────────────────────────────
    // If the user chose a single page or range, narrow pdfContent.pages so that
    // all subsequent passes (2, 3, Vision OCR, 7, 4, 5, 6) only process those pages.
    // Pass 1 already ran on the full document so structural context is preserved.
    if (opts?.startPage !== undefined || opts?.endPage !== undefined) {
      const rangeStart = opts.startPage ?? 1;
      const rangeEnd   = opts.endPage ?? pdfContent.totalPages;
      pdfContent.pages = pdfContent.pages.filter(
        (p) => p.pageNumber >= rangeStart && p.pageNumber <= rangeEnd
      );
      pdfContent.fullText = pdfContent.pages.map((p) => p.text).join("\n\n");
      logger.info({ manualId, rangeStart, rangeEnd, filteredPages: pdfContent.pages.length }, "Page range filter applied");
      await setActivity(manualId, `Page range p${rangeStart}–p${rangeEnd} selected — processing ${pdfContent.pages.length} pages...`);
    }

    // ── Pass 2: Page content ─────────────────────────────────────────────────
    // pass2PageContent already checks which pages exist and only inserts new ones.
    await pass2PageContent(manualId, pdfContent.pages);

    // ── Sparse-page Vision OCR (MUST happen before Pass 3) ───────────────────
    // Run Vision OCR on every page where pdf-parse returned < 20 chars —
    // these are either scanned pages or blank pages.  We decide per-page rather
    // than using a whole-document ratio so mixed-format PDFs (part text, part
    // scanned wiring diagrams) get correct OCR on their image pages without
    // flooding fully-text pages through the vision pipeline.
    //
    // The check uses RAW extracted text, before any Pass 3 description patching.
    // If we did it after, Pass 3's placeholder descriptions would look non-empty
    // and prevent Vision OCR from running at all.
    const sparsePages = pdfContent.pages.filter((p) => !p.text || p.text.trim().length < 20);
    const sparsePageNums = sparsePages.map((p) => p.pageNumber);

    if (sparsePageNums.length > 0) {
      // ── Vision OCR runs BEFORE Pass 3 so Pass 3 gets real image text ──────
      // Check whether vision OCR was already fully (or partially) completed
      // for the sparse pages (resume-safe: passVisionOcr skips already-written rows).
      const ocrRows = await db
        .select({ pageNumber: manualPagesTable.pageNumber, rawText: manualPagesTable.rawText })
        .from(manualPagesTable)
        .where(and(eq(manualPagesTable.manualId, manualId), isNotNull(manualPagesTable.rawText)));
      // Only count rows with substantial text — pdf-parse fills even blank pages
      // with a few whitespace chars which must not be treated as real OCR output.
      const ocrSavedPages = new Map(
        ocrRows
          .filter((r) => (r.rawText ?? "").trim().length >= 20 && sparsePageNums.includes(r.pageNumber))
          .map((r) => [r.pageNumber, r.rawText!])
      );

      if (ocrSavedPages.size >= sparsePageNums.length * 0.8) {
        // OCR already done for the sparse pages — patch in-memory from DB
        logger.info({ manualId, saved: ocrSavedPages.size, sparsePages: sparsePageNums.length }, "Vision OCR: skipping — rawText already in DB");
        await setActivity(manualId, `Vision OCR ✓ — ${ocrSavedPages.size} sparse pages already OCR'd, loading from database`);
        for (const page of pdfContent.pages) {
          const saved = ocrSavedPages.get(page.pageNumber);
          if (saved) page.text = saved;
        }
      } else {
        // Run/resume vision OCR only for sparse pages (passVisionOcr saves
        // rawText per-page so a resume skips pages already written).
        logger.info({ manualId, sparsePages: sparsePageNums.length }, "Sparse pages detected — running Vision OCR before Pass 3");
        await setActivity(manualId, `Vision OCR — scanning ${sparsePageNums.length} sparse/scanned pages (pages: ${sparsePageNums.join(", ")})`);
        const ocrPages = await passVisionOcr(manualId, pdfBuffer, sparsePageNums);
        for (const ocrPage of ocrPages) {
          const page = pdfContent.pages.find((p) => p.pageNumber === ocrPage.pageNumber);
          if (page) page.text = ocrPage.text;
        }
      }
      pdfContent.fullText = pdfContent.pages.map((p) => p.text).join("\n\n");
    }

    // ── Pass 3: Vision descriptions ──────────────────────────────────────────
    // Runs AFTER vision OCR (if this is an image-based PDF) so it has real text
    // context instead of empty strings.  pass3VisionDescriptions loads existing
    // descriptions from DB and skips pages that already have one.
    const pass3Descriptions = await pass3VisionDescriptions(manualId, pdfContent.fullText, pdfContent.pages);

    // Patch sparse pages in-memory with the AI descriptions Pass 3 generated.
    for (const page of pdfContent.pages) {
      const desc = pass3Descriptions.get(page.pageNumber);
      if (desc && page.text.trim().length < 200) {
        page.text = desc;
      }
    }

    // ── Pass 7: RAG chunking ─────────────────────────────────────────────────
    // pass7EmbedChunks now skips pages that already have chunks in the DB, so
    // a stall mid-pass resumes from the first un-indexed page.
    // updatePass=false so the progress bar doesn't jump to 100% mid-pipeline.
    await pass7EmbedChunks(manualId, pdfContent.pages, pdfBuffer, { updatePass: false });

    // ── Passes 4 / 5 / 5b / 6: entity, relationship, path, hierarchy ─────────
    // All extraction passes now run automatically in the same pipeline.
    // extractGraphFromExistingText reads from manual_pages (already filtered to
    // the selected page range by passes 2 & 3 above) and runs to completion,
    // setting status → "completed" when done.
    await setActivity(manualId, "Text and chunks complete — starting entity & relationship extraction...");
    await extractGraphFromExistingText(manualId, { startPage: opts?.startPage, endPage: opts?.endPage });
    logger.info({ manualId }, "Full pipeline complete");
  } catch (err) {
    logger.error({ err, manualId }, "Extraction pipeline failed");
    await setManualStatus(manualId, "failed", {
      errorMessage: err instanceof Error ? err.message : "Unknown error",
    });
    throw err;
  }
}

// ─── COMPOUND PAGE RE-PROCESSING ─────────────────────────────────────────────
//
// Some pages contain BOTH a wiring diagram AND an inverter/drive parameter table
// (e.g. a large wiring schematic with a settings table in the lower section).
// The standard buildPageInterpretationPrompt classifies the page as
// ELECTRICAL_WIRING and describes only the circuit — the parameter table is
// silently dropped.
//
// buildCompoundPagePrompt always extracts both halves.

function buildCompoundPagePrompt(pageNumber: number): string {
  return `You are an expert engineering document analyst trained in ISO and IEC technical standards.

This is page ${pageNumber} of an engineering manual. This page may contain MULTIPLE content types — treat each independently and extract all of them in full.

━━━ SECTION 1: PAGE CLASSIFICATION & WIRING DIAGRAM ━━━

If this page contains an electrical wiring diagram or schematic (IEC 60617), extract:

PAGE_TYPE: ELECTRICAL_WIRING
POWER RAILS: voltage levels and AC/DC type.
LOADS: each load's label, model, and rating.
SWITCHING ELEMENTS: relays, contactors, switches — model and coil/contact ratings.
CIRCUIT TRACES: for each circuit, describe: power source → switching elements → load, with wire colours and terminal numbers where visible.

If instead the page is a pneumatic/hydraulic schematic (ISO 1219-1/2), extract ACTUATORS, DIRECTIONAL CONTROL VALVES, FLOW CONTROL & CHECK VALVES, PRESSURE/FILTER/REGULATOR, and CIRCUIT FLOW DESCRIPTION.

━━━ SECTION 2: PARAMETER / SETTINGS TABLE (MANDATORY — check carefully) ━━━

Inspect the ENTIRE page, including corners, lower sections, and any inset boxes.

If ANY inverter, drive, servo, or motor controller parameter table is present — rows with parameter IDs in formats such as Pr0–Pr999, #xx.xxx, P.xxx, d.xxx, F.xxx, C.xxx, b.xxx, A.xxx, or any other systematic parameter numbering — extract EVERY row WITHOUT exception:

PARAMETER TABLE:
<inverter label, e.g. "2 INV." or "SP-2403" or "1 INV / A8AP">
PARAM ID | VALUE
PARAM ID | VALUE
... (all rows, do not summarise or skip any)

Rules:
- Extract ALL rows. Do not skip, summarise, or truncate.
- Preserve parameter IDs and values EXACTLY as printed (including dots, leading zeros, letters).
- If the table has multiple columns of parameters side-by-side, read left-to-right across each row.
- If multiple inverters have separate tables on this page, extract each under its own label.
- If NO parameter table is visible anywhere on the page, output: PARAMETER TABLE: none

━━━ SECTION 3: TITLE BLOCK ━━━

If a drawing title block is visible (usually bottom-right or bottom), extract:
DRAWING NO: <value>
SHEET S/N: <value>
SHEET NAME: <value>
PAGE REF: <value>

If the page is blank or contains only unlabelled artwork, output exactly: [diagram only]`;
}

/**
 * Re-runs vision extraction for a specific set of pages using the compound
 * prompt (wiring + parameter table).  Deletes existing chunks for those pages
 * and inserts fresh ones from the new vision output.
 *
 * Used to fix pages where the standard ELECTRICAL_WIRING prompt missed a
 * parameter table in the lower section of the page.
 */
export async function reprocessCompoundPages(
  manualId: number,
  pageNumbers: number[]
): Promise<{ processed: number; errors: number; pages: Array<{ page: number; status: string }> }> {
  if (pageNumbers.length === 0) return { processed: 0, errors: 0, pages: [] };

  // Load PDF from DB
  const [manual] = await db
    .select({ pdfData: manualsTable.pdfData })
    .from(manualsTable)
    .where(eq(manualsTable.id, manualId))
    .limit(1);

  if (!manual?.pdfData) {
    throw new Error(`Manual ${manualId} has no PDF data stored`);
  }

  const pdfBuffer = Buffer.isBuffer(manual.pdfData)
    ? manual.pdfData
    : Buffer.from(manual.pdfData as unknown as string, "hex");

  const { pdfPath, cleanup } = await writePdfToTempFile(pdfBuffer);

  const results: Array<{ page: number; status: string }> = [];
  let processed = 0;
  let errors = 0;

  try {
    for (const pageNumber of pageNumbers) {
      try {
        logger.info({ manualId, pageNumber }, "Compound re-process: running vision with compound prompt");

        const base64Image = await renderPdfPageToBase64FromPath(pdfPath, pageNumber);

        const response = await openai.chat.completions.create({
          model: MODEL,
          max_completion_tokens: 4096,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${base64Image}`, detail: "high" },
                },
                {
                  type: "text",
                  text: buildCompoundPagePrompt(pageNumber),
                },
              ],
            },
          ],
        });

        const newText = response.choices[0]?.message?.content?.trim() ?? "";
        if (!newText || newText === "[diagram only]" || newText.length < 30) {
          results.push({ page: pageNumber, status: "skipped (blank/no content)" });
          continue;
        }

        // Update manual_pages raw_text and description with new content
        await db
          .update(manualPagesTable)
          .set({ rawText: newText, description: newText })
          .where(
            and(
              eq(manualPagesTable.manualId, manualId),
              eq(manualPagesTable.pageNumber, pageNumber)
            )
          );

        // Delete existing chunks for this page
        await db
          .delete(chunksTable)
          .where(
            and(
              eq(chunksTable.manualId, manualId),
              eq(chunksTable.pageNumber, pageNumber)
            )
          );

        // Re-chunk with the new content
        const semanticChunks = chunkPageSemantically(newText);
        for (let ci = 0; ci < semanticChunks.length; ci++) {
          const content = semanticChunks[ci]!.trim();
          if (content.length < 15) continue;
          await db.insert(chunksTable).values({
            manualId,
            pageNumber,
            chunkIndex: ci,
            content,
          });
        }

        logger.info(
          { manualId, pageNumber, chunks: semanticChunks.length },
          "Compound re-process: page re-indexed"
        );
        results.push({ page: pageNumber, status: `ok (${semanticChunks.length} chunks)` });
        processed++;
      } catch (err) {
        logger.error({ err, manualId, pageNumber }, "Compound re-process: page failed");
        results.push({ page: pageNumber, status: `error: ${err instanceof Error ? err.message : String(err)}` });
        errors++;
      }
    }
  } finally {
    await cleanup();
  }

  logger.info({ manualId, processed, errors }, "Compound re-process complete");
  return { processed, errors, pages: results };
}
