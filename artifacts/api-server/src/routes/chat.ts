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
import { eq, sql, ilike, or } from "drizzle-orm";
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
    // Build a tsquery from the question keywords
    const tsQuery = trimmedQuestion
      .replace(/[^a-zA-Z0-9 ]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 10)
      .join(" | ");

    let ragChunks: Array<{
      manual_id: number;
      manual_name: string;
      page_number: number;
      content: string;
      rank: number;
    }> = [];

    if (tsQuery.length > 0) {
      const ftsResult = await db.execute<{
        manual_id: number;
        manual_name: string;
        page_number: number;
        content: string;
        rank: number;
      }>(sql`
        SELECT
          c.manual_id,
          m.name AS manual_name,
          c.page_number,
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
      const fallback = await db.execute<{
        manual_id: number;
        manual_name: string;
        page_number: number;
        content: string;
        rank: number;
      }>(sql`
        SELECT
          c.manual_id,
          m.name AS manual_name,
          c.page_number,
          c.content,
          0::float AS rank
        FROM chunks c
        JOIN manuals m ON m.id = c.manual_id
        ORDER BY c.manual_id DESC, c.page_number ASC
        LIMIT ${TOP_K_CHUNKS}
      `);
      ragChunks = fallback.rows;
    }

    // ── 2. Graph: keyword entity search ────────────────────────────────────
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
      // Pass as a PostgreSQL array literal: '{1,2,3}'::integer[]
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

    // ── 3. Build RAG context ────────────────────────────────────────────────
    const ragContext =
      ragChunks.length > 0
        ? ragChunks
            .map(
              (c, i) =>
                `[Source ${i + 1}: "${c.manual_name}", page ${c.page_number}]\n${c.content}`
            )
            .join("\n\n---\n\n")
        : "No relevant manual excerpts found.";

    // ── 4. Synthesise with GPT-4o ───────────────────────────────────────────
    const systemPrompt = `You are an expert engineering assistant. Engineers ask you questions about industrial machines, components, systems, and procedures described in their uploaded manuals.

Answer the question clearly and precisely using ONLY the information from the provided manual excerpts and knowledge graph data. If the information isn't available in the context, say so honestly — do not fabricate technical details.

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

    // ── 5. Build citations ──────────────────────────────────────────────────
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

    // ── 6. Persist to chat_messages ─────────────────────────────────────────
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
