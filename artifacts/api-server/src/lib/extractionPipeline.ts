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

import { openai } from "@workspace/integrations-openai-ai-server";
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
import { eq, and, count } from "drizzle-orm";
import { extractPdfText, renderPdfPageToBase64, hasDiagramImage, chunkText, chunkPageSemantically, type PdfContent } from "./pdfExtractor.js";
import { Buffer } from "node:buffer";
import { logger } from "./logger.js";

const MODEL = "gpt-5.4";
const MAX_TOKENS = 8192;

async function updateManualPass(manualId: number, pass: number) {
  await db
    .update(manualsTable)
    .set({ processingPass: pass, updatedAt: new Date() })
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
): Promise<{ documentType: string; overview: string }> {
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
    return JSON.parse(raw);
  } catch {
    return { documentType: "other", overview: "" };
  }
}

// ─── PASS 2: Per-page content analysis ─────────────────────────────────────

async function pass2PageContent(
  manualId: number,
  pages: Array<{ pageNumber: number; text: string; hasImages: boolean; hasTables: boolean }>
) {
  await updateManualPass(manualId, 2);

  // Save page records (text + image/table detection)
  const pageRecords = pages.map((p) => ({
    manualId,
    pageNumber: p.pageNumber,
    rawText: p.text,
    hasImages: p.hasImages ? 1 : 0,
    hasTables: p.hasTables ? 1 : 0,
  }));

  // Insert in batches of 20
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

  // For pages with sparse text (likely images/tables), generate descriptions using AI
  const sparsePages = pages.filter((p) => p.hasImages || p.hasTables || p.text.length < 200);

  // Process up to 10 sparse pages with AI descriptions
  const toDescribe = sparsePages.slice(0, 10);

  // Return a map of pageNumber → description so the caller can patch pdfContent
  // in-memory before Pass 7 runs, ensuring FTS chunks contain enriched text.
  const generated = new Map<number, string>();

  for (const page of toDescribe) {
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
  maxChunks = 8
): Promise<ExtractedEntity[]> {
  await updateManualPass(manualId, 4);

  const allEntities: ExtractedEntity[] = [];
  const chunks = chunkText(fullText, 5000);
  const seenNames = new Set<string>();

  for (let ci = 0; ci < Math.min(chunks.length, maxChunks); ci++) {
    const chunk = chunks[ci];
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
IMPORTANT: For measurement entities (distances, pressures, temperatures, tensions), always populate "properties.attributes" with all variant values and "properties.conditions" with any scope qualifiers present in the text.`,
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
  maxChunks = 6,
  entities: ExtractedEntity[] = []
): Promise<ExtractedPath[]> {
  const allPaths: ExtractedPath[] = [];
  const chunks = chunkText(fullText, 4000);

  // Build a compact entity reference list so the model can anchor step descriptions
  // to the exact entity names already extracted in Pass 4, ensuring consistency.
  const entityRef = entities.length > 0
    ? `\n\nKNOWN ENTITIES (use these exact names in stepSequence where applicable):\n${entities.map((e) => `- ${e.name} (${e.type})`).join("\n")}`
    : "";

  for (let ci = 0; ci < Math.min(chunks.length, maxChunks); ci++) {
    const chunk = chunks[ci];
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
  maxChunks = 6
): Promise<ExtractedRelationship[]> {
  await updateManualPass(manualId, 5);

  const entityNames = entities.map((e) => e.name).join(", ");
  const allRelationships: ExtractedRelationship[] = [];
  const chunks = chunkText(fullText, 4000);

  for (let ci = 0; ci < Math.min(chunks.length, maxChunks); ci++) {
    const chunk = chunks[ci];
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
      allRelationships.push(...relationships);
    } catch (err) {
      logger.warn({ err, chunk: ci }, "Relationship extraction failed for chunk");
    }
  }

  return allRelationships;
}

// ─── PASS 6: Ordering & hierarchy ───────────────────────────────────────────

async function pass6OrderingHierarchy(
  manualId: number,
  fullText: string,
  entities: ExtractedEntity[]
): Promise<{ hierarchyNotes: string }> {
  await updateManualPass(manualId, 6);

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
          content: `Determine the hierarchy and ordering from this engineering manual:\n\n${sample}\n\nKnown entities: ${entities.slice(0, 30).map((e) => e.name).join(", ")}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    return JSON.parse(raw);
  } catch {
    return { hierarchyNotes: "" };
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
  pdfBuffer: Buffer,
  pageNumber: number
): Promise<string | null> {
  try {
    const base64Image = await renderPdfPageToBase64(pdfBuffer, pageNumber);
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

  // Delete old chunks for this manual (idempotent re-runs)
  await db.delete(chunksTable).where(eq(chunksTable.manualId, manualId));

  let totalChunks = 0;
  let restructuredPages = 0;
  let diagramPages = 0;
  for (const page of pages) {
    if (!page.text || page.text.trim().length < 20) continue;

    let textToChunk = page.text;

    // Diagram gate: if pdfBuffer is available, check whether any embedded image
    // on this page is a line drawing or schematic (midtone pixel fraction < 25%).
    // If so, replace the garbled OCR with a structured vision description that
    // correctly interprets the diagram per the relevant ISO/IEC standard.
    // This takes priority over the tabular restructuring path below.
    if (pdfBuffer && await hasDiagramImage(pdfBuffer, page.pageNumber)) {
      const visionText = await describePageWithVision(pdfBuffer, page.pageNumber);
      if (visionText) {
        textToChunk = visionText;
        diagramPages++;
        logger.info(
          { manualId, pageNumber: page.pageNumber },
          "Pass 7: diagram page replaced with vision description"
        );
      }
    } else if (isTabularOcrPage(page.text)) {
      // Pre-process tabular/schematic pages: reconstruct the row-level
      // relationships that OCR linearisation destroyed.  Prose pages pass through
      // unchanged (isTabularOcrPage returns false for them).
      textToChunk = await restructureTabularContent(page.text);
      restructuredPages++;
      logger.info(
        { manualId, pageNumber: page.pageNumber },
        "Pass 7: tabular page restructured"
      );
    }

    const semanticChunks = chunkPageSemantically(textToChunk);

    for (let ci = 0; ci < semanticChunks.length; ci++) {
      const content = semanticChunks[ci]!.trim();
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

If the page is blank or contains only unlabelled artwork with no text, output exactly: [diagram only]`;
}

async function passVisionOcr(
  manualId: number,
  pdfBuffer: Buffer,
  totalPages: number
): Promise<Array<{ pageNumber: number; text: string }>> {
  const results: Array<{ pageNumber: number; text: string }> = [];
  const CONCURRENCY = 5;

  for (let start = 1; start <= totalPages; start += CONCURRENCY) {
    const batch: number[] = [];
    for (let p = start; p < start + CONCURRENCY && p <= totalPages; p++) {
      batch.push(p);
    }

    const batchResults = await Promise.all(
      batch.map(async (pageNumber) => {
        try {
          const base64Image = await renderPdfPageToBase64(pdfBuffer, pageNumber);

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

    // Persist OCR text to manual_pages immediately so progress is saved
    for (const { pageNumber, text } of batchResults) {
      await db
        .update(manualPagesTable)
        .set({ rawText: text })
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
    const ocrPages = await passVisionOcr(manualId, pdfBuffer, totalPages);
    const fullText = ocrPages.map((p) => p.text).join("\n\n");

    // Pass 1: Document structure (from OCR text)
    const structure = await pass1DocumentStructure(manualId, fullText, totalPages);
    await db
      .update(manualsTable)
      .set({ documentType: structure.documentType, updatedAt: new Date() })
      .where(eq(manualsTable.id, manualId));

    // Pass 4: Entity extraction
    const extractedEntities = await pass4EntityExtraction(
      manualId,
      fullText,
      structure.documentType,
      structure.overview ?? ""
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
            properties: null,
            pageReferences: entity.pageReferences ?? [],
            orderIndex: entity.orderIndex ?? null,
          })
          .returning();
        if (inserted) insertedEntities.push({ name: entity.name, id: inserted.id });
      } catch (err) {
        logger.warn({ err, entity: entity.name }, "Entity insert failed");
      }
    }

    // Pass 5: Relationship extraction
    const extractedRelationships = await pass5RelationshipExtraction(
      manualId,
      fullText,
      extractedEntities
    );

    const nameToId = new Map<string, number>();
    for (const e of insertedEntities) nameToId.set(e.name.toLowerCase().trim(), e.id);

    for (const rel of extractedRelationships) {
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
      } catch (err) {
        logger.warn({ err }, "Relationship insert failed");
      }
    }

    // Pass 5b: Path extraction — ordered procedural sequences
    const extractedPaths = await pass5ExtractPaths(manualId, fullText);
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

    // Pass 6: Ordering & hierarchy
    await pass6OrderingHierarchy(manualId, fullText, extractedEntities);

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

  for (let batch_start = startPage; batch_start <= clampedEnd; batch_start += CONCURRENCY) {
    const batch: number[] = [];
    for (let p = batch_start; p < batch_start + CONCURRENCY && p <= clampedEnd; p++) {
      batch.push(p);
    }

    const batchResults = await Promise.all(
      batch.map(async (pageNumber) => {
        try {
          const base64Image = await renderPdfPageToBase64(pdfBuffer, pageNumber);
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
        .set({ rawText: text })
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
  return { pages: totalToProcess, chunks: totalChunks };
}

// ─── EXTRACT GRAPH: run entity/relationship extraction on existing OCR text ───
//
// Runs passes 1, 4, 5, 6 on whatever rawText is already stored in manual_pages.
// Use this after a page-range OCR to populate the knowledge graph without
// re-running the full pipeline or re-downloading the PDF.

export async function extractGraphFromExistingText(
  manualId: number,
  opts?: { entityChunks?: number; relChunks?: number }
): Promise<{ entities: number; relationships: number }> {
  const entityChunks = opts?.entityChunks ?? 8;
  const relChunks = opts?.relChunks ?? 6;

  await setManualStatus(manualId, "processing", { processingPass: 4 });

  const [manual] = await db
    .select({ documentType: manualsTable.documentType })
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
    .where(eq(manualPagesTable.manualId, manualId))
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
    await setManualStatus(manualId, "structure_complete");
    throw new Error(`Manual ${manualId} has no OCR text — run vision OCR first`);
  }

  // Clear existing graph data so re-runs are idempotent
  await db.delete(entitiesTable).where(eq(entitiesTable.manualId, manualId));
  await db.delete(relationshipsTable).where(eq(relationshipsTable.manualId, manualId));
  await db.delete(pathsTable).where(eq(pathsTable.manualId, manualId));

  // Pass 1: document structure (needed for document type + overview context)
  const structure = await pass1DocumentStructure(manualId, fullText, pages.length);
  await db
    .update(manualsTable)
    .set({ documentType: structure.documentType, updatedAt: new Date() })
    .where(eq(manualsTable.id, manualId));

  // Pass 4: entity extraction (configurable depth)
  const extractedEntities = await pass4EntityExtraction(
    manualId,
    fullText,
    structure.documentType,
    structure.overview ?? "",
    entityChunks
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

  // Pass 5: relationship extraction (configurable depth)
  const extractedRelationships = await pass5RelationshipExtraction(
    manualId,
    fullText,
    extractedEntities,
    relChunks
  );

  const nameToId = new Map<string, number>();
  for (const e of insertedEntities) nameToId.set(e.name.toLowerCase().trim(), e.id);

  let relCount = 0;
  for (const rel of extractedRelationships) {
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

  // Pass 5b: path extraction — ordered procedural sequences with scope conditions.
  // Pass extractedEntities so step descriptions reference consistent entity names.
  const extractedPaths = await pass5ExtractPaths(manualId, fullText, relChunks, extractedEntities);
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
      logger.warn({ err, path: path.name }, "Path insert failed");
    }
  }

  // Pass 6: ordering & hierarchy
  await pass6OrderingHierarchy(manualId, fullText, extractedEntities);

  await setManualStatus(manualId, "completed", { processingPass: 7 });
  logger.info(
    { manualId, entities: insertedEntities.length, relationships: relCount, paths: pathCount, entityChunks, relChunks },
    "Graph extraction from existing text complete"
  );
  return { entities: insertedEntities.length, relationships: relCount };
}

// ─── RECHUNK: re-run Pass 7 from stored page text ────────────────────────────

/**
 * Re-applies the semantic chunker to all stored pages for a manual without
 * re-running the full extraction pipeline.  Useful after upgrading the
 * chunking strategy.
 */
export async function rechunkManual(manualId: number): Promise<{ chunks: number }> {
  const pages = await db
    .select({ pageNumber: manualPagesTable.pageNumber, rawText: manualPagesTable.rawText })
    .from(manualPagesTable)
    .where(eq(manualPagesTable.manualId, manualId))
    .orderBy(manualPagesTable.pageNumber);

  if (pages.length === 0) throw new Error(`No pages found for manual ${manualId}`);

  await pass7EmbedChunks(
    manualId,
    pages.map((p) => ({ pageNumber: p.pageNumber, text: p.rawText ?? "" }))
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
  pdfBuffer: Buffer
): Promise<void> {
  try {
    await setManualStatus(manualId, "processing", { processingPass: 0 });

    // Extract PDF text
    const pdfContent = await extractPdfText(pdfBuffer);

    await db
      .update(manualsTable)
      .set({ totalPages: pdfContent.totalPages, updatedAt: new Date() })
      .where(eq(manualsTable.id, manualId));

    // Pass 1: Document structure
    const structure = await pass1DocumentStructure(
      manualId,
      pdfContent.fullText,
      pdfContent.totalPages
    );

    await db
      .update(manualsTable)
      .set({ documentType: structure.documentType, updatedAt: new Date() })
      .where(eq(manualsTable.id, manualId));

    // Pass 2: Page content
    await pass2PageContent(manualId, pdfContent.pages);

    // Pass 3: Vision descriptions — returns a map of pageNumber → description for
    // sparse pages so we can patch pdfContent in-memory before Pass 7 runs.
    const pass3Descriptions = await pass3VisionDescriptions(manualId, pdfContent.fullText, pdfContent.pages);

    // Patch sparse pages in-memory with the AI descriptions Pass 3 generated.
    // Pass 7 (below) uses pdfContent.pages, so without this patch it would chunk
    // the thin original OCR text for those pages instead of the richer description.
    // Diagram pages are exempt — Pass 7's diagram gate handles them with vision
    // analysis which is more accurate than the context-only Pass 3 description.
    for (const page of pdfContent.pages) {
      const desc = pass3Descriptions.get(page.pageNumber);
      if (desc && page.text.trim().length < 200) {
        page.text = desc;
      }
    }

    // Image-PDF detection: if >80% of pages have no text, use GPT-4o vision OCR
    const emptyCount = pdfContent.pages.filter((p) => !p.text || p.text.trim().length < 20).length;
    if (pdfContent.pages.length > 0 && emptyCount / pdfContent.pages.length > 0.8) {
      logger.info({ manualId, emptyCount }, "Image-based PDF detected — running vision OCR");
      const ocrPages = await passVisionOcr(manualId, pdfBuffer, pdfContent.totalPages);
      // Patch pdfContent in-place so downstream passes use the OCR text
      for (const ocrPage of ocrPages) {
        const page = pdfContent.pages.find((p) => p.pageNumber === ocrPage.pageNumber);
        if (page) page.text = ocrPage.text;
      }
      pdfContent.fullText = ocrPages.map((p) => p.text).join("\n\n");
    }

    // Pass 7: RAG chunking — runs automatically so search is ready immediately.
    // pdfBuffer is passed so the diagram gate can run pixel analysis and replace
    // garbled OCR on wiring-diagram / schematic pages with a vision description.
    // updatePass:false keeps the displayed pass number at 3 (not 7) so the UI
    // progress bar doesn't jump forward and then back when entity extraction starts.
    await pass7EmbedChunks(manualId, pdfContent.pages, pdfBuffer, { updatePass: false });

    // Stop here — entity/relationship extraction is triggered manually by the user
    // so they can choose how much of the document to cover before incurring cost.
    await setManualStatus(manualId, "structure_complete", { processingPass: 3 });
    logger.info({ manualId }, "Structure passes complete — awaiting entity extraction");
  } catch (err) {
    logger.error({ err, manualId }, "Extraction pipeline failed");
    await setManualStatus(manualId, "failed", {
      errorMessage: err instanceof Error ? err.message : "Unknown error",
    });
    throw err;
  }
}
