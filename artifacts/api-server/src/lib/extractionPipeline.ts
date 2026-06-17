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
  type Manual,
  type ManualPage,
  type Entity,
  type InsertEntity,
  type InsertRelationship,
} from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { extractPdfText, chunkText, chunkPageSemantically, type PdfContent } from "./pdfExtractor.js";
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
) {
  await updateManualPass(manualId, 3);

  // For pages with sparse text (likely images/tables), generate descriptions using AI
  const sparsePages = pages.filter((p) => p.hasImages || p.hasTables || p.text.length < 200);

  // Process up to 10 sparse pages with AI descriptions
  const toDescribe = sparsePages.slice(0, 10);

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
    } catch (err) {
      logger.warn({ err, page: page.pageNumber }, "Vision pass failed for page");
    }
  }
}

// ─── PASS 4: Entity extraction ──────────────────────────────────────────────

interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
  pageReferences: number[];
  orderIndex?: number;
}

async function pass4EntityExtraction(
  manualId: number,
  fullText: string,
  documentType: string,
  overview: string
): Promise<ExtractedEntity[]> {
  await updateManualPass(manualId, 4);

  const allEntities: ExtractedEntity[] = [];
  const chunks = chunkText(fullText, 5000);
  const seenNames = new Set<string>();

  for (let ci = 0; ci < Math.min(chunks.length, 8); ci++) {
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

Be precise — use the exact names from the text. Do not invent entities not in the text.`,
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
  entities: ExtractedEntity[]
): Promise<ExtractedRelationship[]> {
  await updateManualPass(manualId, 5);

  const entityNames = entities.map((e) => e.name).join(", ");
  const allRelationships: ExtractedRelationship[] = [];
  const chunks = chunkText(fullText, 4000);

  for (let ci = 0; ci < Math.min(chunks.length, 6); ci++) {
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

async function pass7EmbedChunks(
  manualId: number,
  pages: Array<{ pageNumber: number; text: string }>
): Promise<void> {
  await updateManualPass(manualId, 7);

  // Delete old chunks for this manual (idempotent re-runs)
  await db.delete(chunksTable).where(eq(chunksTable.manualId, manualId));

  let totalChunks = 0;
  for (const page of pages) {
    if (!page.text || page.text.trim().length < 20) continue;

    const semanticChunks = chunkPageSemantically(page.text);

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

  logger.info({ manualId, totalChunks }, "Pass 7: semantic chunks stored");
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

    // Pass 3: Vision descriptions
    await pass3VisionDescriptions(manualId, pdfContent.fullText, pdfContent.pages);

    // Pass 4: Entity extraction
    const extractedEntities = await pass4EntityExtraction(
      manualId,
      pdfContent.fullText,
      structure.documentType,
      structure.overview ?? ""
    );

    // Insert entities into DB
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
        logger.warn({ err, entity: entity.name }, "Failed to insert entity");
      }
    }

    // Pass 5: Relationship extraction
    const extractedRelationships = await pass5RelationshipExtraction(
      manualId,
      pdfContent.fullText,
      extractedEntities
    );

    // Build name→id map
    const nameToId = new Map<string, number>();
    for (const e of insertedEntities) {
      if (e.id) nameToId.set(e.name.toLowerCase().trim(), e.id);
    }

    // Insert relationships
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
        logger.warn({ err }, "Failed to insert relationship");
      }
    }

    // Pass 6: Ordering & hierarchy
    await pass6OrderingHierarchy(manualId, pdfContent.fullText, extractedEntities);

    // Pass 7: Embed chunks for RAG
    await pass7EmbedChunks(manualId, pdfContent.pages);

    await setManualStatus(manualId, "completed", { processingPass: 7 });
    logger.info({ manualId }, "Extraction pipeline completed");
  } catch (err) {
    logger.error({ err, manualId }, "Extraction pipeline failed");
    await setManualStatus(manualId, "failed", {
      errorMessage: err instanceof Error ? err.message : "Unknown error",
    });
    throw err;
  }
}
