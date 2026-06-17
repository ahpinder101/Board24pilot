import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  chunksTable,
  chatMessagesTable,
  entitiesTable,
  manualsTable,
  type ChatCitation,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { eq, sql, ilike, or, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";

const router = Router();

const CHAT_MODEL = "gpt-4o";
const TOP_K_CHUNKS = 8;
const TOP_K_ENTITIES = 10;

// POST /chat
router.post("/chat", async (req: Request, res: Response) => {
  const { question, sessionId: incomingSession } = req.body as {
    question?: string;
    sessionId?: string;
  };

  if (!question || typeof question !== "string" || question.trim().length === 0) {
    res.status(400).json({ error: "question is required" });
    return;
  }

  const sessionId = incomingSession ?? randomUUID();
  const trimmedQuestion = question.trim();

  try {
    // ── 1. RAG: full-text search over chunks ─────────────────────────────────
    // Include 2-char tokens (Sq, mm, LH, RH …) — critical abbreviations in
    // engineering manuals that would otherwise be silently dropped.
    const tsQuery = trimmedQuestion
      .replace(/[^a-zA-Z0-9 ]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .slice(0, 12)
      .join(" | ");

    type ChunkRow = {
      id: number;
      manual_id: number;
      manual_name: string;
      page_number: number;
      chunk_index: number;
      content: string;
      rank: number;
    };

    let ragChunks: ChunkRow[] = [];

    if (tsQuery.length > 0) {
      const ftsResult = await db.execute<ChunkRow>(sql`
        SELECT
          c.id,
          c.manual_id,
          m.name AS manual_name,
          c.page_number,
          c.chunk_index,
          c.content,
          ts_rank(c.fts_vector, to_tsquery('english', ${tsQuery})) AS rank
        FROM chunks c
        JOIN manuals m ON m.id = c.manual_id
        WHERE c.fts_vector @@ to_tsquery('english', ${tsQuery})
        ORDER BY rank DESC
        LIMIT ${TOP_K_CHUNKS}
      `);
      ragChunks = ftsResult.rows;
    }

    // Fallback: if FTS returns nothing, grab most-recent chunks as context
    if (ragChunks.length === 0) {
      const fallback = await db.execute<ChunkRow>(sql`
        SELECT
          c.id,
          c.manual_id,
          m.name AS manual_name,
          c.page_number,
          c.chunk_index,
          c.content,
          0::float AS rank
        FROM chunks c
        JOIN manuals m ON m.id = c.manual_id
        ORDER BY c.manual_id DESC, c.page_number ASC
        LIMIT ${TOP_K_CHUNKS}
      `);
      ragChunks = fallback.rows;
    }

    // ── 2. Window expansion: fetch adjacent chunks ────────────────────────────
    // For each FTS-retrieved chunk, also pull chunk_index ± 1 from the same
    // page.  This is a safety net: values tables that immediately follow a
    // retrieved step chunk are automatically included even if FTS ranked them
    // below the cut-off.
    if (ragChunks.length > 0) {
      const retrievedIds = new Set(ragChunks.map((c) => c.id));
      const adjacentIds = new Set<string>(); // "manualId:page:chunkIdx"
      for (const c of ragChunks) {
        for (const delta of [-1, 1]) {
          const adjIdx = c.chunk_index + delta;
          if (adjIdx >= 0) adjacentIds.add(`${c.manual_id}:${c.page_number}:${adjIdx}`);
        }
      }

      if (adjacentIds.size > 0) {
        // Build OR conditions for (manual_id, page_number, chunk_index) triples
        const conditions = Array.from(adjacentIds).map((key) => {
          const [mid, pg, ci] = key.split(":").map(Number);
          return sql`(c.manual_id = ${mid} AND c.page_number = ${pg} AND c.chunk_index = ${ci})`;
        });

        const adjResult = await db.execute<ChunkRow>(sql`
          SELECT
            c.id,
            c.manual_id,
            m.name AS manual_name,
            c.page_number,
            c.chunk_index,
            c.content,
            0::float AS rank
          FROM chunks c
          JOIN manuals m ON m.id = c.manual_id
          WHERE ${sql.join(conditions, sql` OR `)}
        `);

        for (const row of adjResult.rows) {
          if (!retrievedIds.has(row.id)) {
            ragChunks.push(row);
            retrievedIds.add(row.id);
          }
        }

        // Sort: higher-ranked FTS results first, then adjacents by page order
        ragChunks.sort((a, b) => b.rank - a.rank || a.page_number - b.page_number || a.chunk_index - b.chunk_index);
      }
    }

    // ── 3. Graph: keyword entity search ────────────────────────────────────
    const keywords = trimmedQuestion
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(" ")
      .filter((w) => w.length > 3)
      .slice(0, 6);

    let graphEntities: Array<{
      id: number;
      name: string;
      type: string;
      description: string;
      manualName: string;
    }> = [];

    if (keywords.length > 0) {
      const conditions = keywords.map((kw) =>
        or(
          ilike(entitiesTable.name, `%${kw}%`),
          ilike(entitiesTable.description, `%${kw}%`)
        )
      );

      const entityRows = await db
        .select({
          id: entitiesTable.id,
          name: entitiesTable.name,
          type: entitiesTable.type,
          description: entitiesTable.description,
          manualName: manualsTable.name,
        })
        .from(entitiesTable)
        .leftJoin(manualsTable, eq(entitiesTable.manualId, manualsTable.id))
        .where(or(...conditions))
        .limit(TOP_K_ENTITIES);

      graphEntities = entityRows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        description: r.description,
        manualName: r.manualName ?? "Unknown",
      }));
    }

    // Pull relationships for matched entities
    let graphContext = "";
    if (graphEntities.length > 0) {
      const entityIds = graphEntities.map((e) => e.id);
      const pgArrayLiteral = `{${entityIds.join(",")}}`;
      const relRows = await db.execute<{
        source_name: string;
        target_name: string;
        type: string;
        label: string;
      }>(sql`
        SELECT
          se.name AS source_name,
          te.name AS target_name,
          r.type,
          r.label
        FROM relationships r
        JOIN entities se ON se.id = r.source_entity_id
        JOIN entities te ON te.id = r.target_entity_id
        WHERE r.source_entity_id = ANY(${pgArrayLiteral}::integer[])
           OR r.target_entity_id = ANY(${pgArrayLiteral}::integer[])
        LIMIT 30
      `);

      const entitySummary = graphEntities
        .map(
          (e) =>
            `• ${e.name} (${e.type}, from "${e.manualName}"): ${e.description}`
        )
        .join("\n");

      const relSummary = relRows.rows
        .map(
          (r) =>
            `• ${r.source_name} → [${r.type}${r.label ? ": " + r.label : ""}] → ${r.target_name}`
        )
        .join("\n");

      graphContext = `KNOWLEDGE GRAPH ENTITIES:\n${entitySummary}\n\nKNOWLEDGE GRAPH RELATIONSHIPS:\n${relSummary}`;
    }

    // ── 4. Build RAG context ────────────────────────────────────────────────
    const ragContext =
      ragChunks.length > 0
        ? ragChunks
            .map(
              (c, i) =>
                `[Source ${i + 1}: "${c.manual_name}", page ${c.page_number}]\n${c.content}`
            )
            .join("\n\n---\n\n")
        : "No relevant manual excerpts found.";

    // ── 5. Synthesise with GPT-4o ───────────────────────────────────────────
    const systemPrompt = `You are an expert engineering assistant. Engineers ask you questions about industrial machines, components, systems, and procedures described in their uploaded manuals.

Answer the question clearly and precisely using ONLY the information from the provided manual excerpts and knowledge graph data.

CRITICAL RULES FOR ACCURACY:
1. Scope labels: excerpts may begin with a scope qualifier like [Valid only for Sq machines] or [Not valid for Sq machines]. These tell you which machine type the content applies to. Always respect these when answering about specific machine variants. If an excerpt is scoped [Not valid for Sq machines], its values do NOT apply to Sq machines — look in other excerpts for the Sq-specific values.
2. Numeric tables: when an excerpt contains a table of numbers (rows with ± notation, column headers like "Package", "C (mm)", "D (mm)"), read the values directly from that table. Do NOT say a value is unavailable if the table is present in the source excerpts — extract the specific row that matches the question.
3. PDF table formatting: in PDF-extracted text, table values are sometimes concatenated directly to the row label without spaces. For example "TBA 1000 S3" means the TBA 1000 S row has a value of 3; "TBA 750 S250 ±185 ±1" means TBA 750 S: C=250 ±1, D=85 ±1. Parse such rows by reading trailing numbers as the value for the preceding label.
4. Never fabricate technical details. If the information is genuinely absent from all provided excerpts, say so explicitly.

Structure your answer with:
- A direct answer to the question
- Supporting technical details from the manuals
- Relevant component relationships if applicable

Be concise but thorough. Use technical terminology appropriate for engineers.`;

    const userPrompt = `QUESTION: ${trimmedQuestion}

MANUAL EXCERPTS (from text search):
${ragContext}

${graphContext}

Please answer the question based on the above information from the engineering manuals.`;

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 1500,
      temperature: 0.2,
    });

    const answer =
      completion.choices[0]?.message?.content ??
      "Unable to generate an answer.";

    // ── 6. Build citations ──────────────────────────────────────────────────
    const seenManualPages = new Set<string>();
    const citations: ChatCitation[] = [];

    for (const chunk of ragChunks) {
      const key = `${chunk.manual_id}:${chunk.page_number}`;
      if (seenManualPages.has(key)) continue;
      seenManualPages.add(key);

      const entityNamesOnPage = graphEntities
        .filter((e) => e.manualName === chunk.manual_name)
        .map((e) => e.name)
        .slice(0, 5);

      citations.push({
        manualId: chunk.manual_id,
        manualName: chunk.manual_name,
        pageNumber: chunk.page_number,
        excerpt:
          chunk.content.slice(0, 200) +
          (chunk.content.length > 200 ? "…" : ""),
        entityNames:
          entityNamesOnPage.length > 0 ? entityNamesOnPage : undefined,
      });
    }

    // ── 7. Persist to chat_messages ─────────────────────────────────────────
    await db.insert(chatMessagesTable).values({
      sessionId,
      role: "user",
      content: trimmedQuestion,
      citations: null,
    });

    await db.insert(chatMessagesTable).values({
      sessionId,
      role: "assistant",
      content: answer,
      citations,
    });

    res.json({
      answer,
      citations,
      sessionId,
      graphEntities: graphEntities.map((e) => e.name),
    });
  } catch (err) {
    req.log.error({ err }, "Chat endpoint error");
    res.status(500).json({ error: "Failed to process question" });
  }
});

// GET /chat/:sessionId/history
router.get("/chat/:sessionId/history", async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const messages = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.sessionId, sessionId))
    .orderBy(chatMessagesTable.createdAt);
  res.json(messages);
});

export default router;
