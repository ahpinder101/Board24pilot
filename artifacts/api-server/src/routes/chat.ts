import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  chunksTable,
  chatMessagesTable,
  entitiesTable,
  pathsTable,
  manualsTable,
  feedbackTable,
  type ChatCitation,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";

const router = Router();

const CHAT_MODEL = "gpt-4o";
const TOP_K_CHUNKS = 8;         // cross-manual global FTS limit
const TOP_K_SCOPED = 14;        // domain-scoped second-pass — can be higher because
                                 // we're already within one manual and want full coverage
const TOP_K_ENTITIES = 10;

// ── Vision pre-pass ────────────────────────────────────────────────────────
// When an image is attached, run a cheap GPT-4o vision call BEFORE retrieval
// to extract technical keywords from what the image shows.  These are merged
// with the question text so that FTS queries are grounded in the actual image
// content (component names, fault codes, part numbers, labels) rather than
// just the often-generic question words ("what is this?", "what does this mean?").
async function extractImageKeywords(
  imageDataUrl: string,
  question: string,
  log: (msg: string) => void
): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are helping retrieve sections of an engineering manual that are relevant to this image.

The engineer's question is: "${question}"

Examine the image carefully and extract the most useful technical search terms that would identify the right section of a manual. Include:
- Component names, part names, assembly names visible or identifiable
- Any text, labels, codes, or identifiers visible in the image (fault codes, error codes, part numbers, model numbers, alarm codes)
- Technical terms describing what you see (e.g. "level probe", "float assembly", "pressure transducer", "wiring diagram", "terminal block")
- Functional purpose of what is shown if identifiable

Respond with ONLY a comma-separated list of keywords. No explanations or sentences. Maximum 20 keywords.`,
            },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "low" } },
          ],
        },
      ],
      max_tokens: 120,
      temperature: 0,
    });
    const keywords = response.choices[0]?.message?.content ?? "";
    log(`Vision pre-pass extracted: ${keywords}`);
    return keywords;
  } catch {
    log("Vision pre-pass failed, continuing with question-only FTS");
    return "";
  }
}

// ── Identifier token extraction ────────────────────────────────────────────
// Extracts part numbers / catalogue codes from the question — alphanumeric
// tokens containing hyphens or slashes (e.g. QST-5/16-12, MFH-5-1/2,
// 1492-SPM1D160).  These are destroyed by FTS tokenisation, so they need a
// separate ILIKE search path backed by the trigram GIN index.
function extractIdentifierTokens(text: string): string[] {
  // Pattern: at least two alphanumeric segments separated by - or /
  const pattern = /\b[A-Z0-9]{2,}(?:[-\/][A-Z0-9]+){1,}\b/gi;
  const matches = [...text.matchAll(pattern)].map((m) => m[0]);
  // Also bare long numeric part numbers (5+ digits, e.g. catalogue numbers)
  const numeric = [...text.matchAll(/\b\d{5,}\b/g)].map((m) => m[0]);
  return [...new Set([...matches, ...numeric])].slice(0, 6);
}

// Words too generic to use as manual-name or entity-name signals for domain detection
const GENERIC_NAME_WORDS = new Set([
  "manual", "unit", "machine", "system", "maintenance",
  "document", "guide", "handbook", "instruction", "vacuum",
  "packaging", "packing", "touch", "use", "user",
]);

// ── Domain classification ──────────────────────────────────────────────────
// Returns the manual IDs the question is most likely about.
// Three signals, in priority order:
//   A1. Explicit: machine entity names (from entities table) appear in the
//       question text.  Handles "What does the VERTICAL VACUUM PACKAGING
//       MACHINE…" where the DB manual name ("user manual fu912") gives no signal.
//   A2. Explicit: manual name keywords appear verbatim in the question text.
//       Handles "In the Maverick…" / "on the Tetra Pak machine…" style questions.
//   B.  Implicit: which manuals did the FTS chunk search already return hits from?
//       Handles domain-specific terminology that maps naturally to one manual.
// Falls back to all manuals when neither signal fires (e.g. cross-cutting questions).
function classifyDomain(
  question: string,
  allManuals: Array<{ id: number; name: string }>,
  ftsChunks: Array<{ manual_id: number; rank: number }>,
  machineEntities: Array<{ manualId: number; name: string }>
): number[] {
  const qLower = question.toLowerCase();

  // Signal A1 — machine entity name match
  // Each entity name is split into tokens; if enough distinct tokens appear in
  // the question, this manual is an explicit match.
  const entityExplicit = new Set<number>();
  // Group entities by manual
  const entitiesByManual = new Map<number, string[]>();
  for (const e of machineEntities) {
    const names = entitiesByManual.get(e.manualId) ?? [];
    names.push(e.name);
    entitiesByManual.set(e.manualId, names);
  }
  for (const [manualId, names] of entitiesByManual) {
    for (const name of names) {
      const tokens = name
        .toLowerCase()
        .split(/[\s/\-_]+/)
        .filter((t) => t.length > 3 && !GENERIC_NAME_WORDS.has(t));
      // Require at least 2 distinct tokens to match, preventing false positives
      // from very short entity names.
      if (tokens.length >= 2 && tokens.filter((t) => qLower.includes(t)).length >= 2) {
        entityExplicit.add(manualId);
      } else if (tokens.length === 1 && tokens[0] && qLower.includes(tokens[0])) {
        entityExplicit.add(manualId);
      }
    }
  }
  if (entityExplicit.size > 0) return Array.from(entityExplicit);

  // Signal A2 — explicit manual name match
  const explicit = new Set<number>();
  for (const m of allManuals) {
    const tokens = m.name
      .toLowerCase()
      .split(/[\s/\-_]+/)
      .filter((t) => t.length > 3 && !GENERIC_NAME_WORDS.has(t));
    if (tokens.some((t) => qLower.includes(t))) {
      explicit.add(m.id);
    }
  }
  if (explicit.size > 0) return Array.from(explicit);

  // Signal B — chunk result manual IDs (only from genuinely ranked results)
  const fromChunks = new Set(
    ftsChunks.filter((c) => c.rank > 0).map((c) => c.manual_id)
  );
  if (fromChunks.size > 0) return Array.from(fromChunks);

  // Fallback — search all
  return allManuals.map((m) => m.id);
}

// POST /chat
router.post("/chat", async (req: Request, res: Response) => {
  const { question, sessionId: incomingSession, imageDataUrl } = req.body as {
    question?: string;
    sessionId?: string;
    imageDataUrl?: string;
  };

  if (!question || typeof question !== "string" || question.trim().length === 0) {
    res.status(400).json({ error: "question is required" });
    return;
  }

  const hasImage =
    typeof imageDataUrl === "string" &&
    imageDataUrl.startsWith("data:image/") &&
    imageDataUrl.length > 100;

  const sessionId = incomingSession ?? randomUUID();
  const trimmedQuestion = question.trim();

  try {
    // ── 0. Load manuals + machine entities (needed for domain classification) ─
    const [allManuals, machineEntityRows] = await Promise.all([
      db.select({ id: manualsTable.id, name: manualsTable.name }).from(manualsTable),
      db.execute<{ manual_id: number; name: string }>(sql`
        SELECT manual_id, name FROM entities
        WHERE type IN ('machine', 'system')
        ORDER BY manual_id, order_index
      `),
    ]);

    const machineEntities = machineEntityRows.rows.map((r) => ({
      manualId: r.manual_id,
      name: r.name,
    }));

    // ── 0.5. Vision pre-pass ──────────────────────────────────────────────────
    // When an image is attached, ask GPT-4o to identify what it shows BEFORE
    // retrieval runs.  The extracted keywords are merged with the question text
    // so that FTS is driven by the image content (component name, fault code,
    // part number…) rather than the often-generic question wording.
    let visionKeywords = "";
    if (hasImage) {
      visionKeywords = await extractImageKeywords(
        imageDataUrl!,
        trimmedQuestion,
        (msg) => req.log.info({ msg }, "vision-prepass")
      );
    }

    // Combined search text: question words + vision-extracted keywords
    const searchText =
      visionKeywords.length > 0
        ? `${trimmedQuestion} ${visionKeywords.replace(/,/g, " ")}`
        : trimmedQuestion;

    // ── 1. RAG: full-text search over chunks ─────────────────────────────────
    // Include 2-char tokens (Sq, mm, LH, RH …) — critical abbreviations in
    // engineering manuals that would otherwise be silently dropped.
    // Vision pre-pass keywords are included in searchText when an image was sent.
    const searchTerms = searchText
      .replace(/[^a-zA-Z0-9 ]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .slice(0, 20); // raised from 12 — image keywords can add many more tokens

    const tsQuery = searchTerms.join(" | "); // broad OR query — retrieves context

    // AND query: all terms ≥ 3 chars must be present in the chunk.
    // Used to identify citation chunks (chunks that contain EVERY key term from
    // the question are far more likely to be the actual source of the answer than
    // chunks that just mention one keyword).
    const andTerms = searchTerms.filter((w) => w.length >= 3);
    const andQuery = andTerms.length >= 2 ? andTerms.join(" & ") : null;

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

    // Minimum ts_rank threshold: filters chunks that match only 1-2 tokens from
    // the OR query (e.g. a page that mentions "TMCC2" but has nothing about the
    // specific question).  If the threshold drops everything we fall back to the
    // unthresholded top results so short/single-term queries still work.
    const FTS_RANK_THRESHOLD = 0.01;

    if (tsQuery.length > 0) {
      const ftsResult = await db.execute<ChunkRow>(sql`
        SELECT * FROM (
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
          LIMIT 50
        ) ranked
        WHERE rank > ${FTS_RANK_THRESHOLD}
        ORDER BY rank DESC
        LIMIT ${TOP_K_CHUNKS}
      `);

      if (ftsResult.rows.length > 0) {
        ragChunks = ftsResult.rows;
      } else {
        // Threshold excluded everything — fall back to unthresholded top results
        const fallbackFts = await db.execute<ChunkRow>(sql`
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
        ragChunks = fallbackFts.rows;
      }
    }

    // ── 1b-AND. Run AND query to identify citation-candidate chunks ───────────
    // Chunks matching ALL question terms are very likely the actual source of the
    // answer (e.g. for "TMCC2 Filling OK signal", only the page that talks about
    // the Filling OK signal has every term).  We store their DB IDs now; the
    // citation-building step after the model call uses these IDs instead of the
    // model's self-reported sources (which over-cite topically-related chunks).
    let andQueryChunkIds = new Set<number>();
    if (andQuery) {
      try {
        const andResult = await db.execute<ChunkRow>(sql`
          SELECT
            c.id,
            c.manual_id,
            m.name AS manual_name,
            c.page_number,
            c.chunk_index,
            c.content,
            ts_rank(c.fts_vector, to_tsquery('english', ${andQuery})) AS rank
          FROM chunks c
          JOIN manuals m ON m.id = c.manual_id
          WHERE c.fts_vector @@ to_tsquery('english', ${andQuery})
          ORDER BY rank DESC
          LIMIT 5
        `);
        andQueryChunkIds = new Set(andResult.rows.map((r) => r.id));
        req.log.info(
          { andQuery, count: andResult.rows.length, pages: andResult.rows.map((r) => r.page_number) },
          "chat: AND-query citation candidates"
        );
        // Ensure AND-query chunks are present in ragChunks (they may have been
        // below the rank threshold in the OR pass if a narrower manual has them)
        const existingIds = new Set(ragChunks.map((c) => c.id));
        for (const row of andResult.rows) {
          if (!existingIds.has(row.id)) {
            ragChunks.unshift(row); // prepend — highest priority context
            existingIds.add(row.id);
          }
        }
      } catch {
        // AND query may fail if a term is a stop-word the FTS engine drops; ignore
      }
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

    // ── 1b. Identifier search: ILIKE via trigram GIN index ─────────────────
    // FTS tokenisation destroys structured identifiers (part numbers, model
    // codes) by splitting on hyphens and slashes.  When the question contains
    // such tokens, run a parallel ILIKE search backed by the pg_trgm GIN index
    // and merge any new chunks into ragChunks before domain classification.
    // searchText includes vision-extracted keywords — so fault codes / part numbers
    // visible in an uploaded image are also picked up by the ILIKE path.
    const identifierTokens = extractIdentifierTokens(searchText);
    if (identifierTokens.length > 0) {
      const ilikeConditions = identifierTokens.map(
        (tok) => sql`c.content ILIKE ${"%" + tok + "%"}`
      );
      const identResult = await db.execute<ChunkRow>(sql`
        SELECT
          c.id,
          c.manual_id,
          m.name AS manual_name,
          c.page_number,
          c.chunk_index,
          c.content,
          0.3::float AS rank
        FROM chunks c
        JOIN manuals m ON m.id = c.manual_id
        WHERE ${sql.join(ilikeConditions, sql` OR `)}
        LIMIT ${TOP_K_CHUNKS}
      `);
      const existingIds = new Set(ragChunks.map((c) => c.id));
      for (const row of identResult.rows) {
        if (!existingIds.has(row.id)) {
          ragChunks.push(row);
          existingIds.add(row.id);
        }
      }
    }

    // ── 2. Window expansion: fetch adjacent chunks ────────────────────────────
    // For each FTS-retrieved chunk, also pull chunk_index ± 2 from the same
    // page.  A window of ±2 is needed because dimension/spec tables referenced
    // by "shown in the table below" may be up to two section boundaries away
    // from the sentence that references them (e.g. section 3.2 references the
    // table that OCR placed after section 3.3.1, two chunk_index steps later).
    if (ragChunks.length > 0) {
      const retrievedIds = new Set(ragChunks.map((c) => c.id));
      const adjacentIds = new Set<string>(); // "manualId:page:chunkIdx"
      for (const c of ragChunks) {
        for (const delta of [-2, -1, 1, 2]) {
          const adjIdx = c.chunk_index + delta;
          if (adjIdx >= 0) adjacentIds.add(`${c.manual_id}:${c.page_number}:${adjIdx}`);
        }
      }

      if (adjacentIds.size > 0) {
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

        ragChunks.sort(
          (a, b) =>
            b.rank - a.rank ||
            a.page_number - b.page_number ||
            a.chunk_index - b.chunk_index
        );
      }
    }

    // ── 2b. Domain classification ─────────────────────────────────────────────
    // Determine which manual(s) this question is about, using three signals:
    //   A1. Machine entity names (from the entities table) appear in the question.
    //       This catches cases where the manual DB name ("user manual fu912")
    //       gives no signal but the machine entity name ("VERTICAL VACUUM
    //       PACKAGING MACHINE TOUCH") matches the question directly.
    //   A2. Explicit manual name keywords appear in the question text.
    //   B.  Which manuals produced the top-ranked FTS chunk hits.
    // All graph/entity retrieval below is scoped to these manual IDs.
    const scopedManualIds = classifyDomain(searchText, allManuals, ragChunks, machineEntities);
    const scopedManualArray = `{${scopedManualIds.join(",")}}`;

    // Filter out cross-manual noise: the initial FTS ran before domain
    // classification and can include high-ranking chunks from unrelated manuals
    // that happen to share query tokens.  Now that we know the domain, drop them.
    if (scopedManualIds.length > 0) {
      ragChunks = ragChunks.filter((c) => scopedManualIds.includes(c.manual_id));
    }

    // ── 2c. Domain-scoped second-pass chunk retrieval ─────────────────────────
    // The initial FTS ran cross-manual, so relevant chunks in the target manual
    // may have been outranked globally by chunks from other manuals that happen
    // to share query tokens.  After narrowing the domain, re-run FTS scoped to
    // the classified manual(s) and merge any new top-K chunks into ragChunks.
    if (scopedManualIds.length <= 2 && tsQuery.length > 0) {
      const scopedFtsResult = await db.execute<ChunkRow>(sql`
        SELECT * FROM (
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
          WHERE c.manual_id = ANY(${scopedManualArray}::integer[])
            AND c.fts_vector @@ to_tsquery('english', ${tsQuery})
          ORDER BY rank DESC
          LIMIT 100
        ) ranked
        WHERE rank > ${FTS_RANK_THRESHOLD}
        ORDER BY rank DESC
        LIMIT ${TOP_K_SCOPED}
      `);

      const existingIds = new Set(ragChunks.map((c) => c.id));
      const newChunks: ChunkRow[] = [];
      for (const row of scopedFtsResult.rows) {
        if (!existingIds.has(row.id)) {
          newChunks.push(row);
          existingIds.add(row.id);
        }
      }

      if (newChunks.length > 0) {
        // Also expand window ±2 around the newly added scoped chunks
        const scopedAdjacentIds = new Set<string>();
        for (const c of newChunks) {
          for (const delta of [-2, -1, 1, 2]) {
            const adjIdx = c.chunk_index + delta;
            if (adjIdx >= 0) scopedAdjacentIds.add(`${c.manual_id}:${c.page_number}:${adjIdx}`);
          }
        }
        if (scopedAdjacentIds.size > 0) {
          const adjConditions = Array.from(scopedAdjacentIds).map((key) => {
            const [mid, pg, ci] = key.split(":").map(Number);
            return sql`(c.manual_id = ${mid} AND c.page_number = ${pg} AND c.chunk_index = ${ci})`;
          });
          const scopedAdjResult = await db.execute<ChunkRow>(sql`
            SELECT c.id, c.manual_id, m.name AS manual_name,
                   c.page_number, c.chunk_index, c.content, 0::float AS rank
            FROM chunks c JOIN manuals m ON m.id = c.manual_id
            WHERE ${sql.join(adjConditions, sql` OR `)}
          `);
          for (const row of scopedAdjResult.rows) {
            if (!existingIds.has(row.id)) {
              newChunks.push(row);
              existingIds.add(row.id);
            }
          }
        }

        ragChunks.push(...newChunks);
        ragChunks.sort(
          (a, b) =>
            b.rank - a.rank ||
            a.page_number - b.page_number ||
            a.chunk_index - b.chunk_index
        );
      }

      // ── 2d. Spec-table targeted retrieval ───────────────────────────────────
      // FTS ranking is lexical: if the machine's name contains generic words like
      // "PACKAGING" those words boost packaging-section prose chunks above the
      // spec/dimension table, which is the most relevant chunk for measurement
      // questions.  Since spec-table chunks are tagged at write time with
      // "[Specification table: ...]", we can fetch them directly (bypassing FTS
      // rank) whenever the domain is known.  This guarantees spec tables are
      // always in context when the user asks about dimensions, weights, or specs.
      const specTagQuery = await db.execute<ChunkRow>(sql`
        SELECT c.id, c.manual_id, m.name AS manual_name,
               c.page_number, c.chunk_index, c.content, 0::float AS rank
        FROM chunks c JOIN manuals m ON m.id = c.manual_id
        WHERE c.manual_id = ANY(${scopedManualArray}::integer[])
          AND c.content LIKE '%[Specification table%'
        ORDER BY c.page_number, c.chunk_index
        LIMIT 6
      `);
      const existingIds2 = new Set(ragChunks.map((c) => c.id));
      for (const row of specTagQuery.rows) {
        if (!existingIds2.has(row.id)) {
          ragChunks.push(row);
          existingIds2.add(row.id);
        }
      }
    }

    // ── 3. Graph: FTS entity search scoped to classified domain ──────────────
    // Uses the same FTS relevance model as chunk retrieval (ts_rank + @@ operator)
    // instead of keyword-presence ILIKE, and is scoped to the classified manuals.
    // This ensures entities from unrelated machines are never surfaced.
    const entityFtsQuery = tsQuery; // reuse the same query tokens

    type EntityRow = {
      id: number;
      name: string;
      type: string;
      description: string;
      properties: Record<string, unknown> | null;
      manual_name: string;
      rank: number;
    };

    let graphEntities: Array<{
      id: number;
      name: string;
      type: string;
      description: string;
      properties: Record<string, unknown> | null;
      manualName: string;
    }> = [];

    if (entityFtsQuery.length > 0) {
      const entityResult = await db.execute<EntityRow>(sql`
        SELECT
          e.id,
          e.name,
          e.type,
          COALESCE(e.description, '') AS description,
          e.properties,
          m.name AS manual_name,
          ts_rank(
            to_tsvector('english', e.name || ' ' || COALESCE(e.description, '')),
            to_tsquery('english', ${entityFtsQuery})
          ) AS rank
        FROM entities e
        JOIN manuals m ON m.id = e.manual_id
        WHERE
          e.manual_id = ANY(${scopedManualArray}::integer[])
          AND to_tsvector('english', e.name || ' ' || COALESCE(e.description, ''))
              @@ to_tsquery('english', ${entityFtsQuery})
        ORDER BY rank DESC
        LIMIT ${TOP_K_ENTITIES}
      `);

      graphEntities = entityResult.rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        description: r.description,
        properties: r.properties,
        manualName: r.manual_name,
      }));
    }

    // Pull relationships for matched entities + scoped paths
    type PathRow = {
      id: number;
      name: string;
      path_type: string;
      condition: string | null;
      step_sequence: string[];
      plain_language: string;
      page_references: number[];
    };

    let graphPaths: PathRow[] = [];
    if (entityFtsQuery.length > 0) {
      const pathResult = await db.execute<PathRow>(sql`
        SELECT
          p.id,
          p.name,
          p.path_type,
          p.condition,
          p.step_sequence,
          p.plain_language,
          p.page_references
        FROM paths p
        WHERE
          p.manual_id = ANY(${scopedManualArray}::integer[])
          AND to_tsvector('english', p.name || ' ' || p.plain_language)
              @@ to_tsquery('english', ${entityFtsQuery})
        ORDER BY p.id
        LIMIT 15
      `);
      graphPaths = pathResult.rows;
    }

    // Fallback: if no paths matched by FTS, fetch all paths for the manual
    // (short manuals with few paths benefit from always having them in context)
    if (graphPaths.length === 0 && scopedManualIds.length <= 2) {
      const allPathsResult = await db.execute<PathRow>(sql`
        SELECT id, name, path_type, condition, step_sequence, plain_language, page_references
        FROM paths
        WHERE manual_id = ANY(${scopedManualArray}::integer[])
        ORDER BY id
        LIMIT 20
      `);
      graphPaths = allPathsResult.rows;
    }

    let graphContext = "";
    if (graphEntities.length > 0 || graphPaths.length > 0) {
      const parts: string[] = [];

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

        // Build entity summary — include structured attributes and conditions when present
        const entitySummary = graphEntities
          .map((e) => {
            let line = `• ${e.name} (${e.type}): ${e.description}`;
            const props = e.properties as {
              attributes?: Array<{ value: string; unit?: string; tolerance?: string; applicableTo?: string }>;
              conditions?: string[];
              applicableTo?: string[];
            } | null;
            if (props?.attributes && props.attributes.length > 0) {
              const attrStr = props.attributes
                .map((a) => {
                  const parts: string[] = [];
                  if (a.applicableTo) parts.push(`[${a.applicableTo}]`);
                  parts.push(`${a.value}${a.unit ? " " + a.unit : ""}${a.tolerance ? " " + a.tolerance : ""}`);
                  return parts.join(" ");
                })
                .join(", ");
              line += `\n  Measured values: ${attrStr}`;
            }
            if (props?.conditions && props.conditions.length > 0) {
              line += `\n  Scope conditions: ${props.conditions.join("; ")}`;
            }
            if (props?.applicableTo && props.applicableTo.length > 0) {
              line += `\n  Applicable to: ${props.applicableTo.join(", ")}`;
            }
            return line;
          })
          .join("\n");

        const relSummary = relRows.rows
          .map(
            (r) =>
              `• ${r.source_name} → [${r.type}${r.label ? ": " + r.label : ""}] → ${r.target_name}`
          )
          .join("\n");

        parts.push(`RELATED ENTITIES (with measured values and scope conditions):\n${entitySummary}`);
        if (relSummary) parts.push(`RELATED CONNECTIONS:\n${relSummary}`);
      }

      // Paths: ordered procedural sequences with machine-type scope
      if (graphPaths.length > 0) {
        const pathSummary = graphPaths
          .map((p) => {
            const scopeTag = p.condition ? ` [${p.condition}]` : " [all machines]";
            const steps = Array.isArray(p.step_sequence) && p.step_sequence.length > 0
              ? "\n  Steps: " + p.step_sequence.join(" → ")
              : "";
            return `• ${p.name}${scopeTag}: ${p.plain_language}${steps}`;
          })
          .join("\n");
        parts.push(`PROCEDURE PATHS (machine-type scope in brackets — ONLY apply the path whose scope matches the machine type in the question):\n${pathSummary}`);
      }

      graphContext = parts.join("\n\n");
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

    // ── 4b. Feedback corrections ─────────────────────────────────────────────
    // Search engineer-submitted corrections from previous thumbs-down feedback.
    // Corrections whose question+correction text matches the current query are
    // injected into the prompt as ground-truth overrides.
    let feedbackContext = "";
    if (tsQuery.length > 0) {
      type CorrectionRow = { question: string; correction: string };
      const correctionResult = await db.execute<CorrectionRow>(sql`
        SELECT question, correction
        FROM feedback
        WHERE rating = 'negative'
          AND correction IS NOT NULL
          AND correction <> ''
          AND to_tsvector('english', question || ' ' || correction)
              @@ to_tsquery('english', ${tsQuery})
        ORDER BY created_at DESC
        LIMIT 5
      `);
      if (correctionResult.rows.length > 0) {
        feedbackContext =
          "ENGINEER CORRECTIONS (submitted by engineers who found previous answers wrong or incomplete — treat these as ground truth that takes priority over manual excerpts if they conflict):\n" +
          correctionResult.rows
            .map((r, i) => `[Correction ${i + 1}]\nOriginal question: ${r.question}\nCorrection: ${r.correction}`)
            .join("\n\n");
      }
    }

    // ── 5. Synthesise with GPT-4o ───────────────────────────────────────────
    const systemPrompt = `You are an expert engineering assistant. Engineers ask you questions about industrial machines, components, systems, and procedures described in their uploaded manuals.

Answer the question clearly and precisely using ONLY the information from the provided manual excerpts.

CRITICAL RULES FOR ACCURACY:
1. Scope labels: excerpts may begin with a scope qualifier like [Valid only for Sq machines] or [Not valid for Sq machines]. These tell you which machine type the content applies to. Always respect these when answering about specific machine variants. If an excerpt is scoped [Not valid for Sq machines], its values do NOT apply to Sq machines — look in other excerpts for the Sq-specific values.
2. Numeric tables: when an excerpt contains a table of numbers (rows with ± notation, column headers like "Package", "C (mm)", "D (mm)"), read the values directly from that table. Do NOT say a value is unavailable if the table is present in the source excerpts — extract the specific row that matches the question.
3. PDF table formatting: in PDF-extracted text, table values are sometimes concatenated directly to the row label without spaces. For example "TBA 1000 S3" means the TBA 1000 S row has a value of 3; "TBA 750 S250 ±185 ±1" means TBA 750 S: C=250 ±1, D=85 ±1. Parse such rows by reading trailing numbers as the value for the preceding label.
4. Repeated identifier lists: when a part number, catalogue code, or component name appears as a repeated list in an excerpt (the same identifier on consecutive lines, e.g. "QST-5/16-12\nQST-5/16-12\nQST-5/16-12…"), each repetition represents one physical instance. Count them — that count IS the answer to "how many" questions about that item. Then look at context lines immediately after the list to identify which assemblies they serve.
5. Dimension tables: when an excerpt shows a table with lettered column headers (A, B, C …) and numeric values below them, those letters refer to labelled dimensions in a figure. Report all available dimension values (e.g. "A=515mm, B=435mm, C=385mm") and note which figure they reference. If the question asks for a specific dimension (e.g. "height") but the table only has A/B/C labels, provide all dimensions and note the figure reference so the engineer can identify which is height.
6. Machine dimensions vs packaging dimensions: manuals typically contain TWO separate dimension tables — one for the machine itself (e.g. "Machine dimensions and weight", Fig 2.x) and one for the shipping/packaging box (e.g. "Delivery and handling", Fig 3.x). When the question asks about the machine's height/size, answer from the MACHINE dimensions table. When the question asks about the box or packaging the machine ships in, answer from the PACKAGING dimensions table. If both are present in the excerpts, clearly label which is which.
7. Never fabricate technical details. If the information is genuinely absent from all provided excerpts, say so explicitly.
8. Verbatim values — this is absolute: for any specific value (number, measurement, angle, distance, duration, temperature, product name, part number, model code, catalogue code, phone number, URL, or proper noun) you MUST copy it character-for-character from the excerpt text above. Do NOT paraphrase it, round it, convert its units, or recall it from memory. If the exact value does not appear literally in one of the Source excerpts, write "The manual does not specify this" — never substitute a plausible-sounding figure. This rule exists because engineers act on these values and a wrong number causes real harm.

FORMATTING:
- Write in plain prose. Do NOT use markdown bold (**text**), headers (##), or bullet dashes that start with **.
- You may use numbered lists (1. 2. 3.) and plain dashes (-) for bullet points.${
  hasImage
    ? `

IMAGE ANALYSIS:
The user has attached a photo along with their question. Analyse the image carefully:
- Identify any visible components, parts, labels, damage, wear, or anomalies.
- Cross-reference what you see with the manual excerpts provided.
- If you can identify the part or component from the image, say so and explain what the manual says about it.
- If the image shows damage or abnormal condition, describe it and refer to any relevant maintenance or troubleshooting guidance in the manuals.
- If you cannot identify the part from the image alone, describe what you see and ask clarifying follow-up questions.`
    : ""
}

OUTPUT FORMAT — respond with valid JSON only, no other text:
{
  "answer": "your plain-text answer here",
  "sources": [1, 2]
}

CITATION RULES — this is critical:
- "sources" must list ONLY the Source N numbers from which you directly drew a specific fact, value, procedure, or statement that appears in your answer.
- Do NOT cite a source just because it mentions the same component or keyword as the question.
- Ask yourself: "Did I copy or paraphrase a specific piece of information from this source into my answer?" If no, do not include it.
- Example: if Source 3 says "the Filling OK signal is sent when level is within ±10%" and your answer states that fact, cite Source 3. If Source 7 only says "the TMCC2 controls filling" but you did not use that in your answer, do NOT cite Source 7.
- If you used nothing from the excerpts, set sources to [].`;

    const userPrompt = `QUESTION: ${trimmedQuestion}

${feedbackContext ? feedbackContext + "\n\n" : ""}MANUAL EXCERPTS (from text search):
${ragContext}

${graphContext}

Please answer the question based on the above information from the engineering manuals.`;

    const userMessageContent: Parameters<typeof openai.chat.completions.create>[0]["messages"][number]["content"] =
      hasImage
        ? [
            { type: "text", text: userPrompt },
            { type: "image_url", image_url: { url: imageDataUrl!, detail: "high" } },
          ]
        : userPrompt;

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessageContent },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1500,
      temperature: 0,
    });

    // ── 6. Parse JSON response and build citations ───────────────────────────
    // The model returns { answer: string, sources: number[] } where sources
    // contains the [Source N] numbers it actually drew from.  We look those up
    // directly in ragChunks — no scoring or inference needed.
    const rawContent = completion.choices[0]?.message?.content ?? "{}";
    let parsed: { answer?: string; sources?: number[] } = {};
    try {
      parsed = JSON.parse(rawContent) as { answer?: string; sources?: number[] };
    } catch {
      req.log.warn({ rawContent }, "chat: failed to parse JSON response from model");
    }

    // Safety strip: remove any stray ** bold the model may have included.
    const answer = (parsed.answer ?? "Unable to generate an answer.")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .trim();

    const citedSourceNumbers: number[] = Array.isArray(parsed.sources)
      ? parsed.sources.filter((n) => Number.isInteger(n) && n >= 1 && n <= ragChunks.length)
      : [];

    req.log.info({ citedSourceNumbers }, "chat: model-reported sources");

    // Map 1-based source numbers → 0-based chunk indices
    const modelCitedIndices = new Set<number>(citedSourceNumbers.map((n) => n - 1));

    // ── 6b. Determine citations from AND-query results ───────────────────────
    // The AND query (run before the model call) found chunks containing ALL the
    // distinctive question terms.  Those are the true source pages — no
    // content-matching heuristics needed.  Fall back to model-reported sources
    // only when the AND query returned nothing (vague/single-term questions).
    const indicesToCite = new Set<number>();

    if (andQueryChunkIds.size > 0) {
      for (let i = 0; i < ragChunks.length; i++) {
        if (andQueryChunkIds.has(ragChunks[i].id)) {
          indicesToCite.add(i);
          req.log.info(
            { chunkPage: ragChunks[i].page_number },
            "chat: citation from AND-query"
          );
        }
      }
    }

    // Fallback: AND query empty → use model-reported sources
    if (indicesToCite.size === 0) {
      for (const n of citedSourceNumbers) {
        if (n >= 1 && n <= ragChunks.length) {
          indicesToCite.add(n - 1);
          req.log.info(
            { chunkPage: ragChunks[n - 1].page_number },
            "chat: citation fallback to model-reported source"
          );
        }
      }
    }

    // Final fallback: show top chunk rather than no source
    if (indicesToCite.size === 0 && ragChunks.length > 0) indicesToCite.add(0);

    const seenManualPages = new Set<string>();
    const citations: ChatCitation[] = [];

    for (let i = 0; i < ragChunks.length; i++) {
      if (!indicesToCite.has(i)) continue;
      const chunk = ragChunks[i];
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
      // Debug info: which manuals were searched
      _scope: {
        manualIds: scopedManualIds,
        manualNames: allManuals
          .filter((m) => scopedManualIds.includes(m.id))
          .map((m) => m.name),
      },
    });
  } catch (err) {
    req.log.error({ err }, "Chat endpoint error");
    res.status(500).json({ error: "Failed to process question" });
  }
});

// GET /chat/:sessionId/history
router.get("/chat/:sessionId/history", async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId);
  const messages = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.sessionId, sessionId))
    .orderBy(chatMessagesTable.createdAt);
  res.json(messages);
});

export default router;
