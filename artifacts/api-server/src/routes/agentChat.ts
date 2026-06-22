import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  chatMessagesTable,
  manualsTable,
  type ChatCitation,
} from "@workspace/db";
import { openai } from "../lib/openai.js";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  detectDomain,
  runDomainSpecialist,
  buildGuidedNoAnswer,
  type TechnicalDomain,
  type AnswerStrictness,
  type EvidenceSummary,
} from "../lib/domainSpecialist.js";

const router = Router();

const CHAT_MODEL = "gpt-4o";
const TOP_K_CHUNKS = 8;
const TOP_K_SCOPED = 14;
const TOP_K_PROCEDURAL = 24;
const TOP_K_ENTITIES = 10;
const FTS_RANK_THRESHOLD = 0.01;

/** Matches questions that ask for a full multi-step procedure. */
const PROCEDURAL_QUERY_RE =
  /\b(walk\s+me\s+through|step[-\s]by[-\s]step|steps?\s+to\s+\w|how\s+(do\s+I|to)\s+(replace|remove|install|disassemble|assemble|adjust|clean|set\s+up|change|perform|fix)|procedure\s+for|guide\s+me|show\s+me\s+(how|the\s+steps?)|all\s+steps?|sequence\s+for|process\s+of)\b/i;

const GENERIC_NAME_WORDS = new Set([
  "manual", "unit", "machine", "system", "maintenance",
  "document", "guide", "handbook", "instruction", "vacuum",
  "packaging", "packing", "touch", "use", "user",
]);

const PHRASE_STOPWORDS = new Set([
  "which", "what", "where", "when", "who", "whom", "whose", "why", "how",
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
  "from", "with", "by", "is", "are", "was", "were", "be", "been", "being",
  "its", "it", "this", "that", "these", "those", "as", "than", "into", "out",
  "do", "does", "did", "has", "have", "had", "will", "would", "can", "could",
  "should", "may", "might", "must", "shall",
]);

async function extractImageKeywords(
  imageDataUrl: string,
  question: string,
  log: (msg: string) => void
): Promise<string> {
  try {
    const visionCompletion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are analysing an image attached to an engineering question. Extract a short comma-separated list of technical keywords visible in or strongly implied by the image. Focus on: component names, part numbers, model codes, fault codes, labels, material types, connector types, or visible damage. Return ONLY the keyword list, no explanation.\n\nQuestion context: "${question}"`,
            },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "low" } },
          ],
        },
      ],
      max_tokens: 80,
      temperature: 0,
    });
    const kw = visionCompletion.choices[0]?.message?.content?.trim() ?? "";
    log(`vision keywords: ${kw}`);
    return kw;
  } catch {
    return "";
  }
}

function extractIdentifierTokens(text: string): string[] {
  const pattern = /\b([A-Z]{1,4}[-/][A-Z0-9]{1,10}[-/]?[A-Z0-9]{0,8})\b/g;
  const matches = [...text.matchAll(pattern)].map((m) => m[0]);
  const numeric = [...text.matchAll(/\b\d{5,}\b/g)].map((m) => m[0]);
  return [...new Set([...matches, ...numeric])].slice(0, 6);
}

function classifyDomain(
  question: string,
  allManuals: Array<{ id: number; name: string }>,
  ftsChunks: Array<{ manual_id: number; rank: number }>,
  machineEntities: Array<{ manualId: number; name: string }>
): number[] {
  const qLower = question.toLowerCase();

  const entitiesByManual = new Map<number, string[]>();
  for (const e of machineEntities) {
    const names = entitiesByManual.get(e.manualId) ?? [];
    names.push(e.name);
    entitiesByManual.set(e.manualId, names);
  }

  const entityExplicit = new Set<number>();
  for (const [manualId, names] of entitiesByManual) {
    for (const name of names) {
      const tokens = name
        .toLowerCase()
        .split(/[\s/\-_]+/)
        .filter((t) => t.length > 3 && !GENERIC_NAME_WORDS.has(t));
      if (tokens.length >= 2 && tokens.filter((t) => qLower.includes(t)).length >= 2) {
        entityExplicit.add(manualId);
      } else if (tokens.length === 1 && tokens[0] && qLower.includes(tokens[0])) {
        entityExplicit.add(manualId);
      }
    }
  }
  if (entityExplicit.size > 0) return Array.from(entityExplicit);

  const explicit = new Set<number>();
  for (const m of allManuals) {
    const tokens = m.name
      .toLowerCase()
      .split(/[\s/\-_]+/)
      .filter((t) => t.length > 3 && !GENERIC_NAME_WORDS.has(t));
    if (tokens.some((t) => qLower.includes(t))) explicit.add(m.id);
  }
  if (explicit.size > 0) return Array.from(explicit);

  const fromChunks = new Set(ftsChunks.filter((c) => c.rank > 0).map((c) => c.manual_id));
  if (fromChunks.size > 0) return Array.from(fromChunks);

  return allManuals.map((m) => m.id);
}

const normalizeForMatch = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type ChunkRow = {
  id: number;
  manual_id: number;
  manual_name: string;
  page_number: number;
  chunk_index: number;
  content: string;
  rank: number;
};

type EntityRow = {
  id: number;
  name: string;
  type: string;
  description: string;
  properties: Record<string, unknown> | null;
  manual_name: string;
  rank: number;
};

type PathRow = {
  id: number;
  name: string;
  path_type: string;
  condition: string | null;
  step_sequence: string[];
  plain_language: string;
  page_references: number[];
};

// POST /chat/agent
router.post("/chat/agent", async (req: Request, res: Response) => {
  const {
    question,
    sessionId: incomingSession,
    imageDataUrl,
    domain: requestedDomain,
    strictness: requestedStrictness,
    retrievalMode: requestedRetrievalMode,
    fromPage: requestedFromPage,
    toPage: requestedToPage,
    minConfidence: requestedMinConfidence,
  } = req.body as {
    question?: string;
    sessionId?: string;
    imageDataUrl?: string;
    domain?: string;
    strictness?: string;
    retrievalMode?: string;
    fromPage?: number;
    toPage?: number;
    minConfidence?: string;
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

  const strictness: AnswerStrictness =
    requestedStrictness === "engineering_strict" || requestedStrictness === "safety_critical"
      ? (requestedStrictness as AnswerStrictness)
      : "normal";

  type RetrievalMode = "fact_lookup" | "process_trace" | "troubleshooting_flow" | "relationship_trace";
  const retrievalMode: RetrievalMode = (
    ["fact_lookup", "process_trace", "troubleshooting_flow", "relationship_trace"].includes(requestedRetrievalMode ?? "")
      ? (requestedRetrievalMode as RetrievalMode)
      : "fact_lookup"
  );
  const fromPage = typeof requestedFromPage === "number" && requestedFromPage > 0 ? requestedFromPage : null;
  const toPage = typeof requestedToPage === "number" && requestedToPage > 0 ? requestedToPage : null;
  const ftsRankThreshold = requestedMinConfidence === "high" ? 0.15 : requestedMinConfidence === "medium" ? 0.05 : FTS_RANK_THRESHOLD;

  try {
    // ── 0. Load manuals + machine entities ───────────────────────────────────
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

    // ── 0.5. Vision pre-pass ─────────────────────────────────────────────────
    let visionKeywords = "";
    if (hasImage) {
      visionKeywords = await extractImageKeywords(
        imageDataUrl!,
        trimmedQuestion,
        (msg) => req.log.info({ msg }, "agent-vision-prepass")
      );
    }

    const searchText =
      visionKeywords.length > 0
        ? `${trimmedQuestion} ${visionKeywords.replace(/,/g, " ")}`
        : trimmedQuestion;

    // Procedural walk-through queries get a larger retrieval window so multi-page
    // procedures can pull all relevant pages into the validator's evidence window.
    const isProceduralQuery = PROCEDURAL_QUERY_RE.test(trimmedQuestion) || retrievalMode === "process_trace";
    const topK = isProceduralQuery ? TOP_K_PROCEDURAL : TOP_K_CHUNKS;
    const topKScoped = isProceduralQuery ? TOP_K_PROCEDURAL * 2 : TOP_K_SCOPED;

    // ── 1. FTS retrieval ─────────────────────────────────────────────────────
    const searchTerms = searchText
      .replace(/[^a-zA-Z0-9 ]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .slice(0, 20);

    const tsQuery = searchTerms.join(" | ");
    const andTerms = searchTerms.filter((w) => w.length >= 3);
    const andQuery = andTerms.length >= 2 ? andTerms.join(" & ") : null;

    let ragChunks: ChunkRow[] = [];

    if (tsQuery.length > 0) {
      const ftsResult = await db.execute<ChunkRow>(sql`
        SELECT * FROM (
          SELECT
            c.id, c.manual_id, m.name AS manual_name,
            c.page_number, c.chunk_index, c.content,
            ts_rank(c.fts_vector, to_tsquery('english', ${tsQuery})) AS rank
          FROM chunks c JOIN manuals m ON m.id = c.manual_id
          WHERE c.fts_vector @@ to_tsquery('english', ${tsQuery})
          ORDER BY rank DESC
          LIMIT 50
        ) ranked
        WHERE rank > ${ftsRankThreshold}
        ORDER BY rank DESC
        LIMIT ${topK}
      `);

      if (ftsResult.rows.length > 0) {
        ragChunks = ftsResult.rows;
      } else {
        const fallback = await db.execute<ChunkRow>(sql`
          SELECT c.id, c.manual_id, m.name AS manual_name,
                 c.page_number, c.chunk_index, c.content,
                 ts_rank(c.fts_vector, to_tsquery('english', ${tsQuery})) AS rank
          FROM chunks c JOIN manuals m ON m.id = c.manual_id
          WHERE c.fts_vector @@ to_tsquery('english', ${tsQuery})
          ORDER BY rank DESC
          LIMIT ${topK}
        `);
        ragChunks = fallback.rows;
      }
    }

    // ── 1a. Phrase retrieval ─────────────────────────────────────────────────
    const phraseChunkIds = new Set<number>();
    const phraseContextChunks: ChunkRow[] = [];
    {
      const rawWords = searchText.replace(/[^a-zA-Z0-9 ]/g, " ").trim().split(/\s+/);
      const sequences: string[][] = [];
      let current: string[] = [];
      for (const w of rawWords) {
        if (w.length < 2 || PHRASE_STOPWORDS.has(w.toLowerCase())) {
          if (current.length >= 2) sequences.push(current);
          current = [];
        } else {
          current.push(w);
        }
      }
      if (current.length >= 2) sequences.push(current);

      const phrases: { text: string; len: number }[] = [];
      const seen = new Set<string>();
      for (const seq of sequences) {
        for (let n = Math.min(4, seq.length); n >= 2; n--) {
          for (let i = 0; i + n <= seq.length; i++) {
            const t = seq.slice(i, i + n).join(" ");
            const key = t.toLowerCase();
            if (!seen.has(key)) { seen.add(key); phrases.push({ text: t, len: n }); }
          }
        }
      }
      phrases.sort((a, b) => b.len - a.len);

      const SPECIFIC_MAX = 8;
      type PhraseRow = ChunkRow & { total_matches: number };
      const addedCtx = new Set<number>();
      const citationCandidates = new Map<number, number>();

      for (const { text } of phrases.slice(0, 12)) {
        const r = await db.execute<PhraseRow>(sql`
          SELECT c.id, c.manual_id, m.name AS manual_name,
                 c.page_number, c.chunk_index, c.content,
                 ts_rank(c.fts_vector, phraseto_tsquery('english', ${text})) AS rank,
                 COUNT(*) OVER () AS total_matches
          FROM chunks c JOIN manuals m ON m.id = c.manual_id
          WHERE c.fts_vector @@ phraseto_tsquery('english', ${text})
          ORDER BY rank DESC
          LIMIT 6
        `);
        if (r.rows.length === 0) continue;
        const total = Number(r.rows[0].total_matches);
        const isSpecific = total <= SPECIFIC_MAX;
        for (const row of r.rows) {
          if (isSpecific) {
            const prev = citationCandidates.get(row.id);
            if (prev === undefined || total < prev) citationCandidates.set(row.id, total);
          }
          if (!addedCtx.has(row.id) && phraseContextChunks.length < topK) {
            phraseContextChunks.push(row);
            addedCtx.add(row.id);
          }
        }
      }

      if (citationCandidates.size > 0) {
        const min = Math.min(...citationCandidates.values());
        for (const [id, m] of citationCandidates) {
          if (m === min) phraseChunkIds.add(id);
        }
      }

      if (phraseContextChunks.length > 0) {
        const existing = new Set(ragChunks.map((c) => c.id));
        for (let i = phraseContextChunks.length - 1; i >= 0; i--) {
          const chunk = phraseContextChunks[i];
          if (!existing.has(chunk.id)) { ragChunks.unshift(chunk); existing.add(chunk.id); }
        }
      }
    }

    // ── 1b. AND query citation candidates ────────────────────────────────────
    let andQueryChunkIds = new Set<number>();
    if (andQuery) {
      try {
        const andResult = await db.execute<ChunkRow>(sql`
          SELECT c.id, c.manual_id, m.name AS manual_name,
                 c.page_number, c.chunk_index, c.content,
                 ts_rank(c.fts_vector, to_tsquery('english', ${andQuery})) AS rank
          FROM chunks c JOIN manuals m ON m.id = c.manual_id
          WHERE c.fts_vector @@ to_tsquery('english', ${andQuery})
          ORDER BY rank DESC
          LIMIT 5
        `);
        andQueryChunkIds = new Set(andResult.rows.map((r) => r.id));
        const existingIds = new Set(ragChunks.map((c) => c.id));
        for (const row of andResult.rows) {
          if (!existingIds.has(row.id)) { ragChunks.unshift(row); existingIds.add(row.id); }
        }
      } catch { /* stop-word in AND query — ignore */ }
    }

    // Fallback: grab recent chunks if FTS returned nothing
    if (ragChunks.length === 0) {
      const fallback = await db.execute<ChunkRow>(sql`
        SELECT c.id, c.manual_id, m.name AS manual_name,
               c.page_number, c.chunk_index, c.content, 0::float AS rank
        FROM chunks c JOIN manuals m ON m.id = c.manual_id
        ORDER BY c.manual_id DESC, c.page_number ASC
        LIMIT ${topK}
      `);
      ragChunks = fallback.rows;
    }

    // ── 1c. Identifier ILIKE search ──────────────────────────────────────────
    const identifierTokens = extractIdentifierTokens(searchText);
    if (identifierTokens.length > 0) {
      const ilikeConditions = identifierTokens.map(
        (tok) => sql`c.content ILIKE ${"%" + tok + "%"}`
      );
      const identResult = await db.execute<ChunkRow>(sql`
        SELECT c.id, c.manual_id, m.name AS manual_name,
               c.page_number, c.chunk_index, c.content, 0.3::float AS rank
        FROM chunks c JOIN manuals m ON m.id = c.manual_id
        WHERE ${sql.join(ilikeConditions, sql` OR `)}
        LIMIT ${topK}
      `);
      const existing = new Set(ragChunks.map((c) => c.id));
      for (const row of identResult.rows) {
        if (!existing.has(row.id)) { ragChunks.push(row); existing.add(row.id); }
      }
    }

    // ── 2. Window expansion ──────────────────────────────────────────────────
    if (ragChunks.length > 0) {
      const retrievedIds = new Set(ragChunks.map((c) => c.id));
      const adjacentIds = new Set<string>();
      for (const c of ragChunks) {
        const windowDeltas = retrievalMode === "process_trace" ? [-3, -2, -1, 1, 2, 3] : [-2, -1, 1, 2];
      for (const delta of windowDeltas) {
          const adj = c.chunk_index + delta;
          if (adj >= 0) adjacentIds.add(`${c.manual_id}:${c.page_number}:${adj}`);
        }
      }
      if (adjacentIds.size > 0) {
        const conditions = Array.from(adjacentIds).map((key) => {
          const [mid, pg, ci] = key.split(":").map(Number);
          return sql`(c.manual_id = ${mid} AND c.page_number = ${pg} AND c.chunk_index = ${ci})`;
        });
        const adjResult = await db.execute<ChunkRow>(sql`
          SELECT c.id, c.manual_id, m.name AS manual_name,
                 c.page_number, c.chunk_index, c.content, 0::float AS rank
          FROM chunks c JOIN manuals m ON m.id = c.manual_id
          WHERE ${sql.join(conditions, sql` OR `)}
        `);
        for (const row of adjResult.rows) {
          if (!retrievedIds.has(row.id)) { ragChunks.push(row); retrievedIds.add(row.id); }
        }
        ragChunks.sort((a, b) =>
          b.rank - a.rank || a.page_number - b.page_number || a.chunk_index - b.chunk_index
        );
      }
    }

    // ── 2b. Domain classification ────────────────────────────────────────────
    const scopedManualIds = classifyDomain(searchText, allManuals, ragChunks, machineEntities);
    const scopedManualArray = `{${scopedManualIds.join(",")}}`;

    if (scopedManualIds.length > 0) {
      ragChunks = ragChunks.filter((c) => scopedManualIds.includes(c.manual_id));
    }

    // ── 2c. Domain-scoped second-pass retrieval ──────────────────────────────
    if (scopedManualIds.length <= 2 && tsQuery.length > 0) {
      const scopedFts = await db.execute<ChunkRow>(sql`
        SELECT * FROM (
          SELECT c.id, c.manual_id, m.name AS manual_name,
                 c.page_number, c.chunk_index, c.content,
                 ts_rank(c.fts_vector, to_tsquery('english', ${tsQuery})) AS rank
          FROM chunks c JOIN manuals m ON m.id = c.manual_id
          WHERE c.manual_id = ANY(${scopedManualArray}::integer[])
            AND c.fts_vector @@ to_tsquery('english', ${tsQuery})
            ${fromPage !== null ? sql`AND c.page_number >= ${fromPage}` : sql``}
            ${toPage !== null ? sql`AND c.page_number <= ${toPage}` : sql``}
          ORDER BY rank DESC
          LIMIT 100
        ) ranked
        WHERE rank > ${ftsRankThreshold}
        ORDER BY rank DESC
        LIMIT ${topKScoped}
      `);

      const existingIds = new Set(ragChunks.map((c) => c.id));
      const newChunks: ChunkRow[] = [];
      for (const row of scopedFts.rows) {
        if (!existingIds.has(row.id)) { newChunks.push(row); existingIds.add(row.id); }
      }

      if (newChunks.length > 0) {
        const scopedAdjIds = new Set<string>();
        for (const c of newChunks) {
          for (const delta of [-2, -1, 1, 2]) {
            const adj = c.chunk_index + delta;
            if (adj >= 0) scopedAdjIds.add(`${c.manual_id}:${c.page_number}:${adj}`);
          }
        }
        if (scopedAdjIds.size > 0) {
          const adjConds = Array.from(scopedAdjIds).map((key) => {
            const [mid, pg, ci] = key.split(":").map(Number);
            return sql`(c.manual_id = ${mid} AND c.page_number = ${pg} AND c.chunk_index = ${ci})`;
          });
          const adjResult = await db.execute<ChunkRow>(sql`
            SELECT c.id, c.manual_id, m.name AS manual_name,
                   c.page_number, c.chunk_index, c.content, 0::float AS rank
            FROM chunks c JOIN manuals m ON m.id = c.manual_id
            WHERE ${sql.join(adjConds, sql` OR `)}
          `);
          for (const row of adjResult.rows) {
            if (!existingIds.has(row.id)) { newChunks.push(row); existingIds.add(row.id); }
          }
        }
        ragChunks.push(...newChunks);
        ragChunks.sort((a, b) =>
          b.rank - a.rank || a.page_number - b.page_number || a.chunk_index - b.chunk_index
        );
      }

      // Spec-table targeted retrieval
      const specResult = await db.execute<ChunkRow>(sql`
        SELECT c.id, c.manual_id, m.name AS manual_name,
               c.page_number, c.chunk_index, c.content, 0::float AS rank
        FROM chunks c JOIN manuals m ON m.id = c.manual_id
        WHERE c.manual_id = ANY(${scopedManualArray}::integer[])
          AND c.content LIKE '%[Specification table%'
        ORDER BY c.page_number, c.chunk_index
        LIMIT 6
      `);
      const existingIds2 = new Set(ragChunks.map((c) => c.id));
      for (const row of specResult.rows) {
        if (!existingIds2.has(row.id)) { ragChunks.push(row); existingIds2.add(row.id); }
      }
    }

    // ── 2d. Per-manual proportional allocation (procedural queries) ──────────
    // For walk-through queries, cross-manual FTS noise can crowd the top-K
    // window with chunks from unrelated manuals. Give the highest-ranked manual
    // a guaranteed majority share (≥70 %) so the validator sees coherent evidence.
    if (isProceduralQuery && ragChunks.length > 0) {
      // Count total rank score per manual to identify the dominant one.
      const manualRankSum = new Map<number, number>();
      for (const c of ragChunks) {
        manualRankSum.set(c.manual_id, (manualRankSum.get(c.manual_id) ?? 0) + (c.rank ?? 0));
      }
      const topManualId = [...manualRankSum.entries()].sort((a, b) => b[1] - a[1])[0]![0];

      const budget = topKScoped;
      const topManualBudget = Math.ceil(budget * 0.7);
      const otherBudget = budget - topManualBudget;

      const topManualChunks = ragChunks.filter((c) => c.manual_id === topManualId).slice(0, topManualBudget);
      const otherChunks = ragChunks.filter((c) => c.manual_id !== topManualId).slice(0, otherBudget);

      ragChunks = [...topManualChunks, ...otherChunks];
      ragChunks.sort((a, b) =>
        a.page_number - b.page_number || a.chunk_index - b.chunk_index
      );
    }

    // ── 3. Graph retrieval ────────────────────────────────────────────────────
    let graphEntities: Array<{
      id: number; name: string; type: string; description: string;
      properties: Record<string, unknown> | null; manualName: string;
    }> = [];

    let graphPaths: PathRow[] = [];

    if (tsQuery.length > 0) {
      const [entityResult, pathResult] = await Promise.all([
        db.execute<EntityRow>(sql`
          SELECT e.id, e.name, e.type,
                 COALESCE(e.description, '') AS description, e.properties,
                 m.name AS manual_name,
                 ts_rank(
                   to_tsvector('english', e.name || ' ' || COALESCE(e.description, '')),
                   to_tsquery('english', ${tsQuery})
                 ) AS rank
          FROM entities e JOIN manuals m ON m.id = e.manual_id
          WHERE e.manual_id = ANY(${scopedManualArray}::integer[])
            AND to_tsvector('english', e.name || ' ' || COALESCE(e.description, ''))
                @@ to_tsquery('english', ${tsQuery})
          ORDER BY rank DESC
          LIMIT ${TOP_K_ENTITIES}
        `),
        db.execute<PathRow>(sql`
          SELECT p.id, p.name, p.path_type, p.condition, p.step_sequence, p.plain_language, p.page_references
          FROM paths p
          WHERE p.manual_id = ANY(${scopedManualArray}::integer[])
            AND to_tsvector('english', p.name || ' ' || p.plain_language)
                @@ to_tsquery('english', ${tsQuery})
          ORDER BY p.id
          LIMIT 15
        `),
      ]);

      graphEntities = entityResult.rows.map((r) => ({
        id: r.id, name: r.name, type: r.type, description: r.description,
        properties: r.properties, manualName: r.manual_name,
      }));
      graphPaths = pathResult.rows;
    }

    // Fallback paths for small manuals
    if (graphPaths.length === 0 && scopedManualIds.length <= 2) {
      const allPaths = await db.execute<PathRow>(sql`
        SELECT id, name, path_type, condition, step_sequence, plain_language, page_references
        FROM paths
        WHERE manual_id = ANY(${scopedManualArray}::integer[])
        ORDER BY id
        LIMIT 20
      `);
      graphPaths = allPaths.rows;
    }

    // Build graph context
    let graphContext = "";
    {
      const parts: string[] = [];

      if (graphEntities.length > 0) {
        const entityIds = graphEntities.map((e) => e.id);
        const pgArray = `{${entityIds.join(",")}}`;
        const relRows = await db.execute<{
          source_name: string; target_name: string; type: string; label: string;
        }>(sql`
          SELECT se.name AS source_name, te.name AS target_name, r.type, r.label
          FROM relationships r
          JOIN entities se ON se.id = r.source_entity_id
          JOIN entities te ON te.id = r.target_entity_id
          WHERE r.source_entity_id = ANY(${pgArray}::integer[])
             OR r.target_entity_id = ANY(${pgArray}::integer[])
          LIMIT 30
        `);

        const entitySummary = graphEntities.map((e) => {
          let line = `• ${e.name} (${e.type}): ${e.description}`;
          const props = e.properties as {
            attributes?: Array<{ value: string; unit?: string; tolerance?: string; applicableTo?: string }>;
            conditions?: string[];
            applicableTo?: string[];
          } | null;
          if (props?.attributes && props.attributes.length > 0) {
            const attrStr = props.attributes.map((a) => {
              const p: string[] = [];
              if (a.applicableTo) p.push(`[${a.applicableTo}]`);
              p.push(`${a.value}${a.unit ? " " + a.unit : ""}${a.tolerance ? " " + a.tolerance : ""}`);
              return p.join(" ");
            }).join(", ");
            line += `\n  Measured values: ${attrStr}`;
          }
          if (props?.conditions && props.conditions.length > 0) {
            line += `\n  Scope conditions: ${props.conditions.join("; ")}`;
          }
          return line;
        }).join("\n");

        const relSummary = relRows.rows
          .map((r) => `• ${r.source_name} → [${r.type}${r.label ? ": " + r.label : ""}] → ${r.target_name}`)
          .join("\n");

        parts.push(`RELATED ENTITIES:\n${entitySummary}`);
        if (relSummary) parts.push(`RELATED CONNECTIONS:\n${relSummary}`);
      }

      if (graphPaths.length > 0) {
        const pathSummary = graphPaths.map((p) => {
          const scope = p.condition ? ` [${p.condition}]` : " [all machines]";
          const steps = Array.isArray(p.step_sequence) && p.step_sequence.length > 0
            ? "\n  Steps: " + p.step_sequence.join(" → ")
            : "";
          return `• ${p.name}${scope}: ${p.plain_language}${steps}`;
        }).join("\n");
        parts.push(`PROCEDURE PATHS:\n${pathSummary}`);
      }

      graphContext = parts.join("\n\n");
    }

    // ── 4. RAG context + feedback corrections ─────────────────────────────────
    const ragContext = ragChunks.length > 0
      ? ragChunks.map((c, i) => `[Source ${i + 1}: "${c.manual_name}", page ${c.page_number}]\n${c.content}`).join("\n\n---\n\n")
      : "No relevant manual excerpts found.";

    let feedbackContext = "";
    if (tsQuery.length > 0) {
      type CorrectionRow = { question: string; correction: string };
      const corrResult = await db.execute<CorrectionRow>(sql`
        SELECT question, correction FROM feedback
        WHERE rating = 'negative'
          AND correction IS NOT NULL AND correction <> ''
          AND to_tsvector('english', question || ' ' || correction)
              @@ to_tsquery('english', ${tsQuery})
        ORDER BY created_at DESC
        LIMIT 5
      `);
      if (corrResult.rows.length > 0) {
        feedbackContext =
          "ENGINEER CORRECTIONS (treat as ground truth if they conflict with manual excerpts):\n" +
          corrResult.rows
            .map((r, i) => `[Correction ${i + 1}]\nOriginal question: ${r.question}\nCorrection: ${r.correction}`)
            .join("\n\n");
      }
    }

    // ── 5. Synthesise with GPT-4o ────────────────────────────────────────────
    const systemPrompt = `You are an expert engineering assistant. Engineers ask you questions about industrial machines, components, systems, and procedures described in their uploaded manuals.

Answer the question clearly and precisely using ONLY the information from the provided manual excerpts.

CRITICAL RULES:
1. Scope labels: excerpts may begin with a scope qualifier like [Valid only for Sq machines]. Always respect these.
2. Numeric tables: read values directly from tables present in the excerpts.
3. Verbatim values — ABSOLUTE: for any specific value (number, measurement, part number, model code) copy it character-for-character from the excerpt. If the exact value does not appear literally, write "The manual does not specify this."
4. Never fabricate technical details.

FORMATTING: Write in plain prose. You may use numbered lists (1. 2. 3.) and plain dashes (-). Do NOT use markdown bold (**text**) or headers (##).${
  hasImage
    ? `\n\nIMAGE ANALYSIS: The user attached a photo. Identify visible components, labels, damage, or anomalies and cross-reference with the manual excerpts.`
    : ""
}

FAULT DIAGNOSIS REASONING — apply when the question describes a fault with confirmed component states (e.g. "relay KA33 is energised", "lamp H06 is lit", "coil is healthy"):
1. SYMPTOM FILTER: Use each confirmed-working component to eliminate upstream causes. If relay KA33 is confirmed energised, its supply and coil are healthy — the fault must be downstream of KA33.
2. CIRCUIT TOPOLOGY: Trace the complete path from supply to load. Identify series components (a fault blocks all downstream loads) vs parallel components (a fault removes only that branch, others continue).
3. COMPONENT FAILURE MODES — reason about realistic failure modes per component type:
   - Diode/rectifier: fails SHORT (passes current in reverse direction, common under overcurrent) or OPEN (blocks current entirely). Short-circuit is more common early in a failure.
   - Relay contact: fails OPEN (load stays off even when coil is energised) or WELDED (load cannot be de-energised).
   - Fuse/breaker: fails OPEN only — it cannot fail short.
   - Solenoid coil: fails OPEN (no energisation / valve won't move) or SHORT (draws excess current and trips upstream protection).
4. ELIMINATION RANKING: List suspects from most to least likely, excluding any component already confirmed healthy. For each suspect, state the specific failure mode (open/short/welded) and why it matches the observed symptom.
5. SUPPLY RAIL CHECK: Always include the supply rail (e.g. P1, 24VDC bus, phase L1) as a candidate — a rail fault affects every load on that rail simultaneously.

OUTPUT FORMAT — respond with valid JSON only:
{
  "quote": "Copy the single sentence from the excerpts that most directly answers the question — character-for-character. If none answers it, write: NOT IN EXCERPTS",
  "answer": "your plain-text answer here",
  "sources": [1, 2]
}

CHAIN-OF-THOUGHT: Complete "quote" first. Your "answer" must be consistent with "quote". If quote is "NOT IN EXCERPTS", answer must say the manual does not specify this.`;

    const userPrompt = `QUESTION: ${trimmedQuestion}

${feedbackContext ? feedbackContext + "\n\n" : ""}MANUAL EXCERPTS:
${ragContext}

${graphContext}

Please answer based on the above information.`;

    const userContent: Parameters<typeof openai.chat.completions.create>[0]["messages"][number]["content"] =
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
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1500,
      temperature: 0,
    });

    const rawContent = completion.choices[0]?.message?.content ?? "{}";
    let parsed: { quote?: string; answer?: string; sources?: number[] } = {};
    try {
      parsed = JSON.parse(rawContent) as typeof parsed;
    } catch {
      req.log.warn({ rawContent }, "agent-chat: failed to parse JSON from model");
    }

    const draftAnswer = (parsed.answer ?? "Unable to generate an answer.")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .trim();

    const quoteRaw = (parsed.quote ?? "").trim();

    // ── 6. Domain detection ──────────────────────────────────────────────────
    const technicalDomain: TechnicalDomain =
      requestedDomain && requestedDomain !== "auto" &&
      ["electrical_control", "hydraulic_schematic", "pneumatic_schematic", "mechanical_assembly", "troubleshooting", "generic_process"].includes(requestedDomain)
        ? (requestedDomain as TechnicalDomain)
        : detectDomain(trimmedQuestion, ragContext);

    req.log.info({ technicalDomain, strictness }, "agent-chat: domain + strictness");

    // Build evidence summary
    const manualsSearched = [
      ...new Set(ragChunks.map((c) => c.manual_name)),
    ];
    const evidenceSummary: EvidenceSummary = {
      chunksFound: ragChunks.length,
      entitiesFound: graphEntities.length,
      pathsFound: graphPaths.length,
      hasGraphContext: graphContext.length > 0,
      manualsSearched,
    };

    // ── 7. Domain Specialist validation ──────────────────────────────────────
    const specialistResult = await runDomainSpecialist({
      question: trimmedQuestion,
      draftAnswer,
      ragContext,
      graphContext,
      domain: technicalDomain,
      strictness,
      evidence: evidenceSummary,
      quote: quoteRaw,
    });

    req.log.info(
      {
        validationStatus: specialistResult.validationStatus,
        confidence: specialistResult.confidence,
        answerability: specialistResult.answerability,
      },
      "agent-chat: specialist result"
    );

    // ── 8. Determine final answer ─────────────────────────────────────────────
    let finalAnswer = draftAnswer;
    let isGuided = false;
    let validationPassCount = 1;
    let revisedOnce = false;
    let finalSpecialistResult = specialistResult;

    if (specialistResult.validationStatus === "revise" && specialistResult.revisedAnswer) {
      revisedOnce = true;
      finalAnswer = specialistResult.revisedAnswer
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .trim();
      req.log.info("agent-chat: using specialist-revised answer — running second validation pass");

      const secondPassResult = await runDomainSpecialist({
        question: trimmedQuestion,
        draftAnswer: finalAnswer,
        ragContext,
        graphContext,
        domain: technicalDomain,
        strictness,
        evidence: evidenceSummary,
        quote: quoteRaw,
      });
      validationPassCount = 2;
      finalSpecialistResult = secondPassResult;
      req.log.info({ secondPassStatus: secondPassResult.validationStatus }, "agent-chat: second validation pass complete");

      if (secondPassResult.validationStatus === "fail" || secondPassResult.answerability === "not_answerable") {
        finalAnswer = buildGuidedNoAnswer(trimmedQuestion, evidenceSummary, secondPassResult.validationSummary);
        isGuided = true;
        req.log.info("agent-chat: second pass failed — using guided no-answer");
      }
    } else if (
      specialistResult.validationStatus === "fail" ||
      specialistResult.answerability === "not_answerable"
    ) {
      finalAnswer = buildGuidedNoAnswer(trimmedQuestion, evidenceSummary, specialistResult.validationSummary);
      isGuided = true;
      req.log.info("agent-chat: using guided no-answer");
    }

    // ── 9. Citation logic (same 4-priority system as chat.ts) ─────────────────
    const citedSourceNumbers = Array.isArray(parsed.sources)
      ? parsed.sources.filter((n) => Number.isInteger(n) && n >= 1 && n <= ragChunks.length)
      : [];

    const indicesToCite = new Set<number>();

    // Priority 0: quote-grounded citation
    if (quoteRaw && quoteRaw.toUpperCase() !== "NOT IN EXCERPTS") {
      const normQuote = normalizeForMatch(quoteRaw);
      if (normQuote.length >= 8) {
        let quoteIdx = ragChunks.findIndex((c) =>
          normalizeForMatch(c.content).includes(normQuote)
        );
        if (quoteIdx === -1) {
          const qTokens = [...new Set(normQuote.split(" ").filter((t) => t.length >= 2))];
          if (qTokens.length >= 3) {
            let best = 0;
            ragChunks.forEach((c, i) => {
              const content = normalizeForMatch(c.content);
              const score = qTokens.filter((t) => content.includes(t)).length / qTokens.length;
              if (score > best) { best = score; quoteIdx = i; }
            });
            if (best < 0.7) quoteIdx = -1;
          }
        }
        if (quoteIdx >= 0) indicesToCite.add(quoteIdx);
      }
    }

    // Priority 1: phrase matches
    if (indicesToCite.size === 0 && phraseChunkIds.size > 0) {
      for (let i = 0; i < ragChunks.length; i++) {
        if (phraseChunkIds.has(ragChunks[i].id)) indicesToCite.add(i);
      }
    }

    // Priority 2: AND query
    if (indicesToCite.size === 0 && andQueryChunkIds.size > 0) {
      for (let i = 0; i < ragChunks.length; i++) {
        if (andQueryChunkIds.has(ragChunks[i].id)) indicesToCite.add(i);
      }
    }

    // Fallback: model-reported sources
    if (indicesToCite.size === 0) {
      for (const n of citedSourceNumbers) {
        if (n >= 1 && n <= ragChunks.length) indicesToCite.add(n - 1);
      }
    }

    // Final fallback: top chunk
    if (indicesToCite.size === 0 && ragChunks.length > 0) indicesToCite.add(0);

    const seenManualPages = new Set<string>();
    const citations: ChatCitation[] = [];

    for (let i = 0; i < ragChunks.length; i++) {
      if (!indicesToCite.has(i)) continue;
      const chunk = ragChunks[i];
      const key = `${chunk.manual_id}:${chunk.page_number}`;
      if (seenManualPages.has(key)) continue;
      seenManualPages.add(key);

      const entityNames = graphEntities
        .filter((e) => e.manualName === chunk.manual_name)
        .map((e) => e.name)
        .slice(0, 5);

      citations.push({
        manualId: chunk.manual_id,
        manualName: chunk.manual_name,
        pageNumber: chunk.page_number,
        excerpt: chunk.content.slice(0, 200) + (chunk.content.length > 200 ? "…" : ""),
        entityNames: entityNames.length > 0 ? entityNames : undefined,
        citationQuality: phraseChunkIds.has(chunk.id)
          ? "strong"
          : andQueryChunkIds.has(chunk.id)
          ? "partial"
          : chunk.rank > 0.01
          ? "weak"
          : "unverified",
      });
    }

    // ── 10. Persist to chat_messages ──────────────────────────────────────────
    await db.insert(chatMessagesTable).values({
      sessionId,
      role: "user",
      content: trimmedQuestion,
      citations: null,
    });

    await db.insert(chatMessagesTable).values({
      sessionId,
      role: "assistant",
      content: finalAnswer,
      citations,
    });

    const finalValidationStatus =
      isGuided ? "failed" :
      finalSpecialistResult.validationStatus === "pass" ? "passed" :
      "passed_with_warnings";

    const missingOrWeakEvidence = [
      ...finalSpecialistResult.validationSummary.missingItems.map((m) => ({
        claimOrQuestionPart: m,
        issue: "missing" as const,
      })),
      ...finalSpecialistResult.validationSummary.weakItems.map((w) => ({
        claimOrQuestionPart: w,
        issue: "weak" as const,
      })),
      ...finalSpecialistResult.validationSummary.unsupportedClaims.map((u) => ({
        claimOrQuestionPart: u,
        issue: "missing" as const,
      })),
      ...(finalSpecialistResult.validationSummary.conflictingClaims ?? []).map((c) => ({
        claimOrQuestionPart: c,
        issue: "conflicting" as const,
      })),
    ];

    res.json({
      answer: finalAnswer,
      citations,
      sessionId,
      graphEntities: graphEntities.map((e) => e.name),
      confidence: finalSpecialistResult.confidence,
      answerability: finalSpecialistResult.answerability,
      domain: technicalDomain,
      isGuided,
      evidenceSummary,
      validationSummary: finalSpecialistResult.validationSummary,
      missingOrWeakEvidence,
      validationMetadata: {
        validationPassCount,
        revisedOnce,
        finalValidationStatus,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Agent chat endpoint error");
    res.status(500).json({ error: "Failed to process question" });
  }
});

export default router;
