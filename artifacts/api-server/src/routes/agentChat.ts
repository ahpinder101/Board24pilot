import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  chatMessagesTable,
  manualsTable,
  manualPagesTable,
  type ChatCitation,
} from "@workspace/db";
import { openai } from "../lib/openai.js";
import { sql, or, and, eq } from "drizzle-orm";
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
const TOP_K_PROCEDURAL = 32;
const TOP_K_ENTITIES = 10;
const FTS_RANK_THRESHOLD = 0.01;

/** Matches questions that ask for a full multi-step procedure. */
const PROCEDURAL_QUERY_RE =
  /\b(walk\s+me\s+through|step[-\s]by[-\s]step|steps?\s+to\s+\w|how\s+(do\s+I|to)\s+(replace|remove|install|disassemble|assemble|adjust|clean|set\s+up|change|perform|fix)|procedure\s+for|guide\s+me|show\s+me\s+(how|the\s+steps?)|all\s+steps?|sequence\s+for|process\s+of)\b/i;

// ── Scratchpad system prompt (Pass 1) ────────────────────────────────────────
const SCRATCHPAD_SYSTEM = `You are the reasoning pass of a two-pass engineering Q\&A system. Before any answer is written, you review all available evidence and decide the best path forward.

STEP 1 — Understand the question in context
Is there prior conversation? If so, how does the current question relate to it? For example, "What is possible cause of this" after a discussion about thread tension refers to that topic.

STEP 2 — Assess the evidence
Scan the retrieved excerpts. What aspects of the question do they cover? What is missing?
Note any "section:" labels in the source headers — these are document section breadcrumbs from the manual's table of contents (e.g. "section: \\"2. INSTALLATION > 2-3. Lubrication\\""). If most relevant evidence comes from a single section, record the most specific common section fragment in sectionHint (e.g. "Lubrication" or "INSTALLATION"). This enables the retrieval agent to pull more chunks from that section. Set sectionHint to null if evidence spans many unrelated sections or no section labels appear.

STEP 3 — Identify the technical domain from the CONTENT of the excerpts (not from keyword counting)
• "electrical_control" — circuits, relays, voltage, contactors, coils, wiring, schematic
• "hydraulic_schematic" — hydraulic fluid, pumps, cylinders, pressure lines, oil
• "pneumatic_schematic" — compressed air, pneumatic actuators, solenoid valves, compressor
• "mechanical_assembly" — parts, install/remove/replace steps, torque, fasteners, knives, needles, assembly
• "troubleshooting" — fault codes, symptoms, diagnostic checks, error messages, alarms
• "generic_process" — settings, adjustments, calibrations, or procedures that don't fit the above

STEP 4 — Choose a strategy
• "answer" — Excerpts cover ANY relevant aspect, even partially. PREFER THIS ALWAYS. A partial answer with caveats is almost always better than asking a clarifying question. Use this even when evidence quality is "weak".
• "clarify" — Use ONLY when the question has two or more genuinely distinct valid interpretations that would each lead to a meaningfully different answer AND you have evidence for at least one interpretation. Write one focused clarifying question.
• "cannot_answer" — LAST RESORT. Use only when excerpts are completely off-topic (evidenceQuality is "none") AND the question is clear enough that clarification won\\'t help retrieve better evidence.

BIAS HEAVILY toward "answer". A partial answer is acceptable and useful. Reserve "cannot_answer" for truly empty, irrelevant evidence.

STEP 5
If strategy is "answer": write brief planNotes for the answer agent — which sources cover which steps, how to order a procedure, what to synthesise. Note any [TABLE] or [LIST] sources that contain structured data relevant to the answer.
If strategy is "clarify": write one focused clarifying question in clarifyingQuestion.
If strategy is "cannot_answer": leave planNotes empty.

Respond with valid JSON only, no other text:
{
  "questionType": "procedure" | "fact" | "troubleshooting" | "follow_up" | "ambiguous",
  "domain": "electrical_control" | "hydraulic_schematic" | "pneumatic_schematic" | "mechanical_assembly" | "troubleshooting" | "generic_process",
  "evidenceQuality": "strong" | "partial" | "weak" | "none",
  "coveredAspects": ["what the evidence covers"],
  "uncoveredAspects": ["what is missing"],
  "strategy": "answer" | "clarify" | "cannot_answer",
  "clarifyingQuestion": "single focused question or null",
  "planNotes": "brief synthesis plan for the answer agent",
  "sectionHint": "most specific section path fragment common to majority of relevant evidence, or null"
}`;

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
  // Docling structural metadata — present when the manual was processed via Docling.
  // Optional so all queries (including window-expansion ones) work without change.
  section_path?: string | null;
  element_type?: string | null;
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
    type HistoryRow = { role: string; content: string };
    const [allManuals, machineEntityRows, historyResult] = await Promise.all([
      db.select({ id: manualsTable.id, name: manualsTable.name }).from(manualsTable),
      db.execute<{ manual_id: number; name: string }>(sql`
        SELECT manual_id, name FROM entities
        WHERE type IN ('machine', 'system')
        ORDER BY manual_id, order_index
      `),
      db.execute<HistoryRow>(sql`
        SELECT role, content FROM chat_messages
        WHERE session_id = ${sessionId}
        ORDER BY created_at DESC
        LIMIT 6
      `),
    ]);

    const machineEntities = machineEntityRows.rows.map((r) => ({
      manualId: r.manual_id,
      name: r.name,
    }));
    // DESC gives newest-first; reverse to restore chronological order for prompts
    const conversationHistory = [...historyResult.rows].reverse();

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
            c.section_path, c.element_type,
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
                 c.section_path, c.element_type,
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
                 c.section_path, c.element_type,
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
                 c.section_path, c.element_type,
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
                 c.section_path, c.element_type,
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

      // ── Cross-page window expansion (procedural queries only) ────────────
      // Numbered procedure steps may be on a different page from the
      // introductory text that scores highest for the user's query terms.
      // Fetch all chunks from directly adjacent pages (page_number ± 1)
      // so inter-page procedure sequences are never truncated.
      if (isProceduralQuery) {
        const seenPageKeys = new Set(ragChunks.map((c) => `${c.manual_id}:${c.page_number}`));
        const crossPageEntries: Array<{ mid: number; pg: number }> = [];
        const addedPageKeys = new Set(seenPageKeys);
        for (const key of seenPageKeys) {
          const [midStr, pgStr] = key.split(":");
          const mid = Number(midStr);
          const pg = Number(pgStr);
          if (!scopedManualIds.includes(mid)) continue;
          for (const delta of [-1, 1]) {
            const nPg = pg + delta;
            const nKey = `${mid}:${nPg}`;
            if (nPg > 0 && !addedPageKeys.has(nKey)) {
              addedPageKeys.add(nKey);
              crossPageEntries.push({ mid, pg: nPg });
            }
          }
        }
        if (crossPageEntries.length > 0) {
          const cappedEntries = crossPageEntries.slice(0, 12);
          const crossPageConds = cappedEntries.map(({ mid, pg }) =>
            sql`(c.manual_id = ${mid} AND c.page_number = ${pg})`
          );
          const crossPageResult = await db.execute<ChunkRow>(sql`
            SELECT c.id, c.manual_id, m.name AS manual_name,
                   c.page_number, c.chunk_index, c.content, 0::float AS rank
            FROM chunks c JOIN manuals m ON m.id = c.manual_id
            WHERE ${sql.join(crossPageConds, sql` OR `)}
            ORDER BY c.page_number, c.chunk_index
            LIMIT 20
          `);
          const existingIds3 = new Set(ragChunks.map((c) => c.id));
          for (const row of crossPageResult.rows) {
            if (!existingIds3.has(row.id)) { ragChunks.push(row); existingIds3.add(row.id); }
          }
        }
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

    // ── 3b. Track B — page-references overlap (procedural queries) ────────────
    // Fetch paths whose page_references overlap with the pages already retrieved
    // by FTS.  page_references is stored as JSONB so we use EXISTS +
    // jsonb_array_elements_text to compare against a PG integer array.
    if (isProceduralQuery && ragChunks.length > 0) {
      const retrievedPages = [...new Set(ragChunks.map((c) => c.page_number))];
      if (retrievedPages.length > 0) {
        const pgArrayLit = `{${retrievedPages.join(",")}}`;
        try {
          const overlapResult = await db.execute<PathRow>(sql`
            SELECT p.id, p.name, p.path_type, p.condition, p.step_sequence, p.plain_language, p.page_references
            FROM paths p
            WHERE p.manual_id = ANY(${scopedManualArray}::integer[])
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(p.page_references) AS elem
                WHERE elem::integer = ANY(${pgArrayLit}::integer[])
              )
            ORDER BY p.id
            LIMIT 15
          `);
          if (overlapResult.rows.length > 0) {
            const existingPathIds = new Set(graphPaths.map((p) => p.id));
            for (const row of overlapResult.rows) {
              if (!existingPathIds.has(row.id)) graphPaths.push(row);
            }
          }
        } catch (overlapErr) {
          req.log.warn({ err: overlapErr }, "agent-chat: Track B overlap query failed — continuing");
        }
      }
    }

    // Build graph context + separate procedure steps section
    let graphContext = "";
    let procedureStepsSection = "";
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
        if (isProceduralQuery) {
          // Procedural queries: paths WITH step_sequence go to the dedicated
          // "PROCEDURE STEPS" section (authoritative, numbered list).
          // Paths without steps stay in graphContext as a summary line.
          const pathsWithSteps = graphPaths.filter(
            (p) => Array.isArray(p.step_sequence) && p.step_sequence.length > 0
          );
          const pathsWithoutSteps = graphPaths.filter(
            (p) => !Array.isArray(p.step_sequence) || p.step_sequence.length === 0
          );

          if (pathsWithSteps.length > 0) {
            procedureStepsSection = pathsWithSteps
              .map((p) => {
                const scope = p.condition ? ` [${p.condition}]` : "";
                const pageRef =
                  Array.isArray(p.page_references) && p.page_references.length > 0
                    ? ` [page ${p.page_references.join(", ")}]`
                    : "";
                const steps = p.step_sequence
                  .map((s, i) => `${i + 1}. ${s}`)
                  .join("\n");
                return `${p.name}${scope}${pageRef}:\n${steps}`;
              })
              .join("\n\n");
          }

          if (pathsWithoutSteps.length > 0) {
            const pathSummary = pathsWithoutSteps
              .map((p) => {
                const scope = p.condition ? ` [${p.condition}]` : " [all machines]";
                return `• ${p.name}${scope}: ${p.plain_language}`;
              })
              .join("\n");
            parts.push(`PROCEDURE PATHS:\n${pathSummary}`);
          }
        } else {
          // Non-procedural queries: all paths go to graphContext as summary lines
          // (no numbered steps injected, non-procedure answer behavior unchanged).
          const pathSummary = graphPaths.map((p) => {
            const scope = p.condition ? ` [${p.condition}]` : " [all machines]";
            const steps = Array.isArray(p.step_sequence) && p.step_sequence.length > 0
              ? "\n  Steps: " + p.step_sequence.join(" → ")
              : "";
            return `• ${p.name}${scope}: ${p.plain_language}${steps}`;
          }).join("\n");
          parts.push(`PROCEDURE PATHS:\n${pathSummary}`);
        }
      }

      graphContext = parts.join("\n\n");
    }

    // ── 4. Printed-page lookup ───────────────────────────────────────────────
    // For manuals processed via Docling, manual_pages.printed_page_number holds
    // the human-readable page label from the document header/footer so the LLM
    // cites the page the user would look up in the physical manual.
    const printedPgMap = new Map<string, string>();
    if (ragChunks.length > 0) {
      const uniquePairs = [
        ...new Map(ragChunks.map((c) => [`${c.manual_id}:${c.page_number}`, c])).values(),
      ];
      try {
        const pgRows = await db
          .select({
            manualId: manualPagesTable.manualId,
            pageNumber: manualPagesTable.pageNumber,
            printedPageNumber: manualPagesTable.printedPageNumber,
          })
          .from(manualPagesTable)
          .where(
            or(
              ...uniquePairs.map((c) =>
                and(
                  eq(manualPagesTable.manualId, c.manual_id),
                  eq(manualPagesTable.pageNumber, c.page_number)
                )
              )
            )
          );
        for (const row of pgRows) {
          if (row.printedPageNumber) {
            printedPgMap.set(`${row.manualId}:${row.pageNumber}`, row.printedPageNumber);
          }
        }
      } catch { /* non-critical: fall back to PDF sequential page number */ }
    }

    // ── 4. RAG context + feedback corrections ─────────────────────────────────
    // Enrich each source label with Docling structural metadata when available:
    //  - section_path: breadcrumb like "2. INSTALLATION > 2-3. Lubrication"
    //  - element_type: content-type hint (TABLE, LIST) so agents read them correctly
    let ragContext = ragChunks.length > 0
      ? ragChunks.map((c, i) => {
          const displayPage = printedPgMap.get(`${c.manual_id}:${c.page_number}`) ?? c.page_number;
          const sectionTag = c.section_path ? `, section: "${c.section_path}"` : "";
          const header = `[Source ${i + 1}: "${c.manual_name}", page ${displayPage}${sectionTag}]`;
          // Prefix table/list content so the answer agent knows how to read it
          const typeHint =
            c.element_type === "table" ? "[TABLE] " :
            c.element_type === "list_item" ? "[LIST] " : "";
          return `${header}\n${typeHint}${c.content}`;
        }).join("\n\n---\n\n")
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

    // ── 4.5. Evidence summary (needed for early returns) ─────────────────────
    const manualsSearched = [...new Set(ragChunks.map((c) => c.manual_name))];
    const evidenceSummary: EvidenceSummary = {
      chunksFound: ragChunks.length,
      entitiesFound: graphEntities.length,
      pathsFound: graphPaths.length,
      hasGraphContext: graphContext.length > 0,
      manualsSearched,
    };

    // ── 4.6. Scratchpad pass — reason before answering ────────────────────────
    type ScratchpadResult = {
      questionType: "procedure" | "fact" | "troubleshooting" | "follow_up" | "ambiguous";
      domain: TechnicalDomain;
      evidenceQuality: "strong" | "partial" | "weak" | "none";
      coveredAspects: string[];
      uncoveredAspects: string[];
      strategy: "answer" | "clarify" | "cannot_answer";
      clarifyingQuestion: string | null;
      planNotes: string;
      /** Docling section breadcrumb fragment observed in evidence — drives section-targeted re-retrieval. Null when not applicable. */
      sectionHint: string | null;
    };

    const historySnippet = conversationHistory.length > 0
      ? `CONVERSATION HISTORY:\n${conversationHistory.map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 400)}`).join("\n")}\n\n`
      : "";

    const scratchpadUserPrompt = `${historySnippet}CURRENT QUESTION: ${trimmedQuestion}

${procedureStepsSection ? `PROCEDURE STEPS (from knowledge graph — authoritative):\n${procedureStepsSection.slice(0, 2000)}\n\n` : ""}RETRIEVED EXCERPTS:
${ragContext.slice(0, 12000)}

${graphContext ? `KNOWLEDGE GRAPH CONTEXT:\n${graphContext.slice(0, 800)}` : ""}

Analyse the evidence and output your scratchpad JSON.`;

    const spCompletion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: SCRATCHPAD_SYSTEM },
        { role: "user", content: scratchpadUserPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 600,
      temperature: 0,
    });

    let scratchpad: ScratchpadResult;
    const validDomainsList = [
      "electrical_control", "hydraulic_schematic", "pneumatic_schematic",
      "mechanical_assembly", "troubleshooting", "generic_process",
    ];
    try {
      const spRaw = spCompletion.choices[0]?.message?.content ?? "{}";
      const sp = JSON.parse(spRaw) as Record<string, unknown>;
      scratchpad = {
        questionType: (["procedure", "fact", "troubleshooting", "follow_up", "ambiguous"] as const).find(
          (v) => v === sp.questionType
        ) ?? "fact",
        domain: validDomainsList.includes(String(sp.domain ?? ""))
          ? (sp.domain as TechnicalDomain)
          : detectDomain(trimmedQuestion, ragContext),
        evidenceQuality: (["strong", "partial", "weak", "none"] as const).find(
          (v) => v === sp.evidenceQuality
        ) ?? "partial",
        coveredAspects: Array.isArray(sp.coveredAspects)
          ? (sp.coveredAspects as unknown[]).filter((x): x is string => typeof x === "string")
          : [],
        uncoveredAspects: Array.isArray(sp.uncoveredAspects)
          ? (sp.uncoveredAspects as unknown[]).filter((x): x is string => typeof x === "string")
          : [],
        strategy: (["answer", "clarify", "cannot_answer"] as const).find(
          (v) => v === sp.strategy
        ) ?? "answer",
        clarifyingQuestion: typeof sp.clarifyingQuestion === "string" ? sp.clarifyingQuestion : null,
        planNotes: typeof sp.planNotes === "string" ? sp.planNotes : "",
        sectionHint: typeof sp.sectionHint === "string" && sp.sectionHint.trim().length > 0
          ? sp.sectionHint.trim()
          : null,
      };
      req.log.info(
        {
          questionType: scratchpad.questionType,
          domain: scratchpad.domain,
          strategy: scratchpad.strategy,
          evidenceQuality: scratchpad.evidenceQuality,
          sectionHint: scratchpad.sectionHint,
        },
        "agent-chat: scratchpad"
      );
    } catch {
      req.log.warn("agent-chat: scratchpad parse failed — defaulting to answer");
      scratchpad = {
        questionType: "fact",
        domain: detectDomain(trimmedQuestion, ragContext),
        evidenceQuality: ragChunks.length > 0 ? "partial" : "none",
        coveredAspects: [],
        uncoveredAspects: [],
        strategy: ragChunks.length > 0 ? "answer" : "cannot_answer",
        clarifyingQuestion: null,
        planNotes: "",
        sectionHint: null,
      };
    }

    // ── 4.7. Strategy branching ───────────────────────────────────────────────
    if (scratchpad.strategy === "clarify" && scratchpad.clarifyingQuestion) {
      const clarifyText = scratchpad.clarifyingQuestion;
      req.log.info("agent-chat: returning clarifying question");
      await db.insert(chatMessagesTable).values({
        sessionId, role: "user", content: trimmedQuestion, citations: null,
      });
      await db.insert(chatMessagesTable).values({
        sessionId, role: "assistant", content: clarifyText, citations: null,
      });
      res.json({
        answer: clarifyText,
        citations: [],
        sessionId,
        graphEntities: [],
        confidence: undefined,
        answerability: "partially_answerable" as const,
        domain: scratchpad.domain,
        isClarifying: true,
        isGuided: false,
        evidenceSummary,
        validationSummary: null,
        missingOrWeakEvidence: [],
        validationMetadata: {
          validationPassCount: 0,
          revisedOnce: false,
          finalValidationStatus: "passed" as const,
        },
      });
      return;
    }

    // ── 4.65a. Section-hint targeted retrieval ────────────────────────────────
    // The scratchpad may observe that most evidence comes from a specific section
    // (e.g. "INSTALLATION > Lubrication") and emit a sectionHint. If so, pull
    // additional chunks from that section using ILIKE on section_path — a simple,
    // lossless way to fetch the rest of a relevant section without any hard-coding.
    // This is purely additive: if sectionHint is null or no results match, nothing changes.
    if (
      scratchpad.sectionHint &&
      scopedManualIds.length > 0
    ) {
      const sectionPattern = `%${scratchpad.sectionHint}%`;
      try {
        const sectionFts = await db.execute<ChunkRow>(sql`
          SELECT c.id, c.manual_id, m.name AS manual_name,
                 c.page_number, c.chunk_index, c.content,
                 c.section_path, c.element_type,
                 0.05::float AS rank
          FROM chunks c JOIN manuals m ON m.id = c.manual_id
          WHERE c.manual_id = ANY(${scopedManualArray}::integer[])
            AND c.section_path ILIKE ${sectionPattern}
          ORDER BY c.page_number, c.chunk_index
          LIMIT 20
        `);

        if (sectionFts.rows.length > 0) {
          const existingSectionIds = new Set(ragChunks.map((c) => c.id));
          let sectionAdded = 0;
          for (const row of sectionFts.rows) {
            if (!existingSectionIds.has(row.id)) {
              ragChunks.push(row);
              existingSectionIds.add(row.id);
              sectionAdded++;
            }
          }
          if (sectionAdded > 0) {
            ragChunks.sort((a, b) => a.page_number - b.page_number || a.chunk_index - b.chunk_index);
            // Rebuild ragContext to include the new section chunks
            ragContext = ragChunks.map((c, i) => {
              const displayPage = printedPgMap.get(`${c.manual_id}:${c.page_number}`) ?? c.page_number;
              const sectionTag = c.section_path ? `, section: "${c.section_path}"` : "";
              const header = `[Source ${i + 1}: "${c.manual_name}", page ${displayPage}${sectionTag}]`;
              const typeHint =
                c.element_type === "table" ? "[TABLE] " :
                c.element_type === "list_item" ? "[LIST] " : "";
              return `${header}\n${typeHint}${c.content}`;
            }).join("\n\n---\n\n");
            req.log.info(
              { sectionHint: scratchpad.sectionHint, added: sectionAdded },
              "agent-chat: section-hint retrieval added chunks"
            );
          }
        }
      } catch (sectionErr) {
        req.log.warn({ err: sectionErr }, "agent-chat: section-hint retrieval failed — continuing");
      }
    }

    // ── 4.65. Scratchpad gap re-retrieval ─────────────────────────────────────
    // The scratchpad may report uncoveredAspects even when strategy === "answer"
    // because the original FTS query used abstract vocabulary ("replenish",
    // "supply") while the actual procedure text uses mechanical terms ("nozzle",
    // "rubber cap", "oil tank"). Re-run FTS using the uncoveredAspects as search
    // terms so vocabulary-mismatched pages are fetched before the answer pass.
    // If sectionHint was observed, try section-scoped gap retrieval first, then
    // fall back to full manual scope so coverage is maximised either way.
    if (
      scratchpad.strategy === "answer" &&
      scratchpad.uncoveredAspects.length > 0 &&
      scopedManualIds.length > 0
    ) {
      const gapTerms = scratchpad.uncoveredAspects
        .join(" ")
        .replace(/[^a-zA-Z0-9 ]/g, " ")
        .trim()
        .split(/\s+/)
        .filter((w) => w.length >= 3)
        .slice(0, 16);
      const gapTsQuery = gapTerms.join(" | ");

      if (gapTsQuery.length > 0) {
        try {
          // When sectionHint is available, bias gap retrieval to that section first
          const sectionGapClause = scratchpad.sectionHint
            ? sql`AND c.section_path ILIKE ${`%${scratchpad.sectionHint}%`}`
            : sql``;

          const gapFts = await db.execute<ChunkRow>(sql`
            SELECT c.id, c.manual_id, m.name AS manual_name,
                   c.page_number, c.chunk_index, c.content,
                   c.section_path, c.element_type,
                   ts_rank(c.fts_vector, to_tsquery('english', ${gapTsQuery})) AS rank
            FROM chunks c JOIN manuals m ON m.id = c.manual_id
            WHERE c.manual_id = ANY(${scopedManualArray}::integer[])
              AND c.fts_vector @@ to_tsquery('english', ${gapTsQuery})
              ${sectionGapClause}
            ORDER BY rank DESC
            LIMIT 12
          `);

          if (gapFts.rows.length > 0) {
            const existingGapIds = new Set(ragChunks.map((c) => c.id));
            const newGapChunks: ChunkRow[] = [];
            for (const row of gapFts.rows) {
              if (!existingGapIds.has(row.id)) {
                newGapChunks.push(row);
                existingGapIds.add(row.id);
              }
            }

            if (newGapChunks.length > 0) {
              // Same-page window expansion on the newly found chunks
              const gapAdjEntries: Array<{ mid: number; pg: number; ci: number }> = [];
              for (const c of newGapChunks) {
                for (const delta of [-2, -1, 1, 2]) {
                  const adj = c.chunk_index + delta;
                  if (adj >= 0) gapAdjEntries.push({ mid: c.manual_id, pg: c.page_number, ci: adj });
                }
              }
              if (gapAdjEntries.length > 0) {
                const gapAdjConds = gapAdjEntries.map(({ mid, pg, ci }) =>
                  sql`(c.manual_id = ${mid} AND c.page_number = ${pg} AND c.chunk_index = ${ci})`
                );
                const gapAdjResult = await db.execute<ChunkRow>(sql`
                  SELECT c.id, c.manual_id, m.name AS manual_name,
                         c.page_number, c.chunk_index, c.content, 0::float AS rank
                  FROM chunks c JOIN manuals m ON m.id = c.manual_id
                  WHERE ${sql.join(gapAdjConds, sql` OR `)}
                `);
                for (const row of gapAdjResult.rows) {
                  if (!existingGapIds.has(row.id)) {
                    newGapChunks.push(row);
                    existingGapIds.add(row.id);
                  }
                }
              }

              ragChunks.push(...newGapChunks);
              ragChunks.sort((a, b) => a.page_number - b.page_number || a.chunk_index - b.chunk_index);
              ragContext = ragChunks
                .map((c, i) => {
                  const displayPage = printedPgMap.get(`${c.manual_id}:${c.page_number}`) ?? c.page_number;
                  const sectionTag = c.section_path ? `, section: "${c.section_path}"` : "";
                  const header = `[Source ${i + 1}: "${c.manual_name}", page ${displayPage}${sectionTag}]`;
                  const typeHint =
                    c.element_type === "table" ? "[TABLE] " :
                    c.element_type === "list_item" ? "[LIST] " : "";
                  return `${header}\n${typeHint}${c.content}`;
                })
                .join("\n\n---\n\n");
              req.log.info(
                { gapChunksAdded: newGapChunks.length, uncoveredAspects: scratchpad.uncoveredAspects, sectionHint: scratchpad.sectionHint },
                "agent-chat: gap re-retrieval added chunks"
              );
            }
          }
        } catch (gapErr) {
          req.log.warn({ err: gapErr }, "agent-chat: gap re-retrieval failed — continuing with existing context");
        }
      }
    }

    if (scratchpad.strategy === "cannot_answer") {
      req.log.info("agent-chat: scratchpad cannot_answer — guided response");
      const guidedText = buildGuidedNoAnswer(trimmedQuestion, evidenceSummary, {
        status: "fail" as const,
        presentItems: scratchpad.coveredAspects,
        missingItems: scratchpad.uncoveredAspects,
        weakItems: [],
        unsupportedClaims: [],
        conflictingClaims: [],
        suggestedGuidance: [],
        citationIssues: [],
        sequenceIssues: [],
      });
      await db.insert(chatMessagesTable).values({
        sessionId, role: "user", content: trimmedQuestion, citations: null,
      });
      await db.insert(chatMessagesTable).values({
        sessionId, role: "assistant", content: guidedText, citations: null,
      });
      res.json({
        answer: guidedText,
        citations: [],
        sessionId,
        graphEntities: [],
        confidence: "unverified" as const,
        answerability: "not_answerable" as const,
        domain: scratchpad.domain,
        isClarifying: false,
        isGuided: true,
        evidenceSummary,
        validationSummary: null,
        missingOrWeakEvidence: scratchpad.uncoveredAspects.map((u) => ({
          claimOrQuestionPart: u,
          issue: "missing" as const,
        })),
        validationMetadata: {
          validationPassCount: 0,
          revisedOnce: false,
          finalValidationStatus: "failed" as const,
        },
      });
      return;
    }

    // ── 5. Synthesise with GPT-4o ────────────────────────────────────────────
    const systemPrompt = `You are an expert engineering assistant. Engineers ask you questions about industrial machines, components, systems, and procedures described in their uploaded manuals.

SCRATCHPAD ANALYSIS (from reasoning pass):
- Question type: ${scratchpad.questionType}
- Evidence quality: ${scratchpad.evidenceQuality}
- Evidence covers: ${scratchpad.coveredAspects.length > 0 ? scratchpad.coveredAspects.join("; ") : "general context"}
- Synthesis plan: ${scratchpad.planNotes || "Answer the question from the provided excerpts as completely as possible."}

Answer the question clearly and precisely using ONLY the information from the provided manual excerpts.

CRITICAL RULES:
1. Scope labels: excerpts may begin with a scope qualifier like [Valid only for Sq machines]. Always respect these.
2. Numeric tables: read values directly from tables present in the excerpts.
3. Verbatim values — ABSOLUTE: for any specific value (number, measurement, part number, model code) copy it character-for-character from the excerpt. If the exact value does not appear literally, write "The manual does not specify this."
4. Never fabricate technical details.
5. Multi-step procedures: synthesise steps from ALL provided excerpts in sequence. No single sentence needs to cover the whole procedure — build it across multiple sources. Never say "the manual does not specify" for a procedure when the excerpts contain relevant steps.
6. PROCEDURE STEPS section: when "PROCEDURE STEPS (verified from knowledge graph)" appears above the excerpts, list every step in full as the primary answer — do not summarise, skip, reorder, or paraphrase any step. Number them exactly as given.

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
  "quote": "The most relevant sentence from the excerpts — character-for-character. Write NOT IN EXCERPTS if no single sentence directly answers. This field is for citation anchoring only and does NOT constrain your answer.",
  "answer": "your full plain-text answer synthesised from all relevant excerpts",
  "sources": [1, 2]
}`;

    const userPrompt = `QUESTION: ${trimmedQuestion}

${feedbackContext ? feedbackContext + "\n\n" : ""}${procedureStepsSection ? `PROCEDURE STEPS (verified from knowledge graph):\n${procedureStepsSection}\n\n` : ""}MANUAL EXCERPTS:
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

    const historyMessages = conversationHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content.slice(0, 1200),
    }));

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...historyMessages,
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
        : scratchpad.domain;

    req.log.info({ technicalDomain, strictness }, "agent-chat: domain + strictness");

    // ── 6b. Build answer-overlap specialist context ────────────────────────────
    // The specialist validates the draft answer against evidence. Passing the full
    // ragContext in page order causes truncation: the specialist may not see the
    // chunks the answer was actually drawn from (which can be anywhere in the
    // retrieval set). Instead, rank all retrieved chunks by token overlap with the
    // draft answer — the chunks that look most like the answer are the ones that
    // supported it. Pass only the top-K so the specialist always sees the right
    // evidence in a compact window, regardless of total retrieval size.
    const SPEC_STOPWORDS = new Set([
      "the","a","an","and","or","but","is","are","was","were","be","been",
      "being","have","has","had","do","does","did","will","would","could",
      "should","may","might","must","can","to","of","in","on","at","for",
      "from","with","by","into","it","its","this","that","these","those",
      "not","no","you","your","they","their","we","our","if","then","when",
      "also","about","more","some","what","how","which","there","here","use",
    ]);
    const draftTokens = new Set(
      draftAnswer.toLowerCase().split(/\W+/).filter(t => t.length > 3 && !SPEC_STOPWORDS.has(t))
    );
    const computeAnswerOverlap = (content: string): number => {
      if (draftTokens.size === 0) return 0;
      const words = content.toLowerCase().split(/\W+/);
      return words.filter(t => draftTokens.has(t)).length / draftTokens.size;
    };

    const scoredForSpec = ragChunks
      .map((c, originalIndex) => ({ chunk: c, originalIndex, overlap: computeAnswerOverlap(c.content) }))
      .sort((a, b) => b.overlap - a.overlap);

    // Top 10 chunks by answer overlap
    const specIdxSet = new Set<number>(scoredForSpec.slice(0, 10).map(s => s.originalIndex));

    // Always include the quote-matched chunk — it is the most precisely grounded evidence
    const quoteNorm = quoteRaw ? normalizeForMatch(quoteRaw) : "";
    if (quoteNorm.length >= 8) {
      const qIdx = ragChunks.findIndex(c => normalizeForMatch(c.content).includes(quoteNorm));
      if (qIdx >= 0) specIdxSet.add(qIdx);
    }

    // Build the specialist context, re-sorted by page/chunk order for readability
    const specialistContext = [...specIdxSet]
      .sort((a, b) =>
        ragChunks[a].page_number - ragChunks[b].page_number ||
        ragChunks[a].chunk_index - ragChunks[b].chunk_index
      )
      .map((idx, i) => {
        const c = ragChunks[idx];
        const displayPage = printedPgMap.get(`${c.manual_id}:${c.page_number}`) ?? c.page_number;
        const sectionTag = c.section_path ? `, section: "${c.section_path}"` : "";
        const header = `[Source ${i + 1}: "${c.manual_name}", page ${displayPage}${sectionTag}]`;
        const typeHint =
          c.element_type === "table" ? "[TABLE] " :
          c.element_type === "list_item" ? "[LIST] " : "";
        return `${header}\n${typeHint}${c.content}`;
      })
      .join("\n\n---\n\n");

    req.log.info(
      { specChunks: specIdxSet.size, totalChunks: ragChunks.length, topOverlap: scoredForSpec[0]?.overlap.toFixed(3) },
      "agent-chat: specialist context built from answer-overlap ranking"
    );

    // ── 7. Domain Specialist validation ──────────────────────────────────────
    // Gate: when the scratchpad assessed strong evidence with no uncovered aspects
    // AND strictness is normal, the answer is well-grounded. The specialist would
    // be checking against the same evidence and finding nothing new — skip it and
    // emit a synthetic pass. For engineering_strict or safety_critical, always run.
    const skipSpecialist =
      scratchpad.evidenceQuality === "strong" &&
      scratchpad.uncoveredAspects.length === 0 &&
      strictness === "normal";

    let specialistResult: Awaited<ReturnType<typeof runDomainSpecialist>>;

    if (skipSpecialist) {
      req.log.info(
        { evidenceQuality: scratchpad.evidenceQuality, strictness },
        "agent-chat: specialist skipped — strong evidence, no gaps, normal strictness"
      );
      specialistResult = {
        validationStatus: "pass",
        confidence: "high",
        answerability: "answerable",
        validationSummary: {
          status: "pass",
          presentItems: scratchpad.coveredAspects,
          missingItems: [],
          weakItems: [],
          unsupportedClaims: [],
          conflictingClaims: [],
          suggestedGuidance: [],
          citationIssues: [],
          sequenceIssues: [],
        },
      };
    } else {
      specialistResult = await runDomainSpecialist({
        question: trimmedQuestion,
        draftAnswer,
        ragContext: specialistContext,
        graphContext,
        domain: technicalDomain,
        strictness,
        evidence: evidenceSummary,
        quote: quoteRaw,
      });
    }

    req.log.info(
      {
        validationStatus: specialistResult.validationStatus,
        confidence: specialistResult.confidence,
        answerability: specialistResult.answerability,
        specialistSkipped: skipSpecialist,
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

      // Gate: skip second validation pass when scratchpad assessed strong evidence.
      // A "revise" on strong-evidence answers is almost always a wording improvement,
      // not a factual correction — no need to pay for another specialist call to confirm.
      const skipSecondPass =
        scratchpad.evidenceQuality === "strong" && strictness === "normal";

      if (skipSecondPass) {
        req.log.info(
          { evidenceQuality: scratchpad.evidenceQuality },
          "agent-chat: second validation pass skipped — strong evidence"
        );
        validationPassCount = 1;
      } else {
        req.log.info("agent-chat: using specialist-revised answer — running second validation pass");
        const secondPassResult = await runDomainSpecialist({
          question: trimmedQuestion,
          draftAnswer: finalAnswer,
          ragContext: specialistContext,
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
      }
    } else if (
      specialistResult.validationStatus === "fail" ||
      specialistResult.answerability === "not_answerable"
    ) {
      // Guard: if the scratchpad assessed strong/partial evidence and the specialist
      // found no actual contradictions (only retrieval gaps in unsupported_claims),
      // keep the draft answer — the specialist may have seen a truncated evidence
      // window that missed the relevant chunks.
      const hasConflicts = specialistResult.validationSummary.conflictingClaims.length > 0;
      const scratchpadConfident =
        scratchpad.evidenceQuality === "strong" || scratchpad.evidenceQuality === "partial";
      if (scratchpadConfident && !hasConflicts) {
        req.log.info(
          { scratchpadEvidence: scratchpad.evidenceQuality, specialistStatus: specialistResult.validationStatus },
          "agent-chat: specialist fail overridden — scratchpad strong/partial evidence with no contradictions"
        );
        // finalAnswer stays as draftAnswer.
        // Clear unsupportedClaims so the UI does not show "Not in retrieved pages"
        // for steps we've already decided to trust — they're retrieval gaps, not errors.
        finalSpecialistResult = {
          ...specialistResult,
          validationStatus: "revise" as const,
          validationSummary: {
            ...specialistResult.validationSummary,
            missingItems: [],
            unsupportedClaims: [],
          },
        };
      } else {
        finalAnswer = buildGuidedNoAnswer(trimmedQuestion, evidenceSummary, specialistResult.validationSummary);
        isGuided = true;
        req.log.info("agent-chat: using guided no-answer");
      }
    }

    // ── 8b. Suppress unsupportedClaims when scratchpad is confident ───────────
    // unsupportedClaims are retrieval gaps — the specialist didn't see a claim
    // in its (truncated) evidence window, but that does NOT mean the answer is wrong.
    // When the scratchpad (which saw the full evidence) assessed quality as
    // strong/partial and the specialist found no genuine contradictions, suppress
    // unsupportedClaims so they don't surface as false "Partial evidence" in the UI.
    if (
      !isGuided &&
      (scratchpad.evidenceQuality === "strong" || scratchpad.evidenceQuality === "partial") &&
      finalSpecialistResult.validationSummary.conflictingClaims.length === 0
    ) {
      const suppressedCount = finalSpecialistResult.validationSummary.unsupportedClaims.length;
      if (suppressedCount > 0) {
        finalSpecialistResult = {
          ...finalSpecialistResult,
          validationSummary: {
            ...finalSpecialistResult.validationSummary,
            unsupportedClaims: [],
          },
        };
        req.log.info(
          { suppressedCount, evidenceQuality: scratchpad.evidenceQuality },
          "agent-chat: suppressed unsupportedClaims — scratchpad confident with no conflicts"
        );
      }
    }

    // ── 9. Citation logic (same 4-priority system as chat.ts) ─────────────────
    const citedSourceNumbers = Array.isArray(parsed.sources)
      ? parsed.sources.filter((n) => Number.isInteger(n) && n >= 1 && n <= ragChunks.length)
      : [];

    // Build answer token set for content-overlap validation and fallback citation.
    const OVERLAP_STOPWORDS_AC = new Set([
      "the","a","an","and","or","but","is","are","was","were","be","been",
      "being","have","has","had","do","does","did","will","would","could",
      "should","may","might","must","can","to","of","in","on","at","for",
      "from","with","by","into","it","its","this","that","these","those",
      "not","no","you","your","they","their","we","our","if","then","when",
      "also","about","more","some","what","how","which","there","here","use",
    ]);
    const acAnswerText = finalAnswer.toLowerCase();
    const acAnswerTokens = new Set(
      acAnswerText.split(/\W+/).filter(t => t.length > 3 && !OVERLAP_STOPWORDS_AC.has(t))
    );
    const acComputeOverlap = (content: string): number => {
      if (acAnswerTokens.size === 0) return 0;
      const words = content.toLowerCase().split(/\W+/);
      return words.filter(t => acAnswerTokens.has(t)).length / acAnswerTokens.size;
    };

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

    // Priority 1: phrase matches — validated against answer content.
    // Stemming can cause a phrase like "oil supply" to match a different page ("oil supplied
    // to the rotary hook") that has nothing to do with the answer. Reject phrase chunks
    // whose content has < 8% word overlap with the answer to filter these false positives.
    if (indicesToCite.size === 0 && phraseChunkIds.size > 0) {
      const modelCitedIds = new Set(
        citedSourceNumbers
          .map((n) => ragChunks[n - 1]?.id)
          .filter((id): id is number => id !== undefined)
      );
      const preferred = [...phraseChunkIds].filter((id) => modelCitedIds.has(id));
      const toUse = preferred.length > 0 ? new Set(preferred) : phraseChunkIds;
      const PHRASE_OVERLAP_MIN = 0.12;
      for (let i = 0; i < ragChunks.length; i++) {
        if (!toUse.has(ragChunks[i].id)) continue;
        const overlap = acComputeOverlap(ragChunks[i].content);
        if (acAnswerTokens.size > 5 && overlap < PHRASE_OVERLAP_MIN) continue;
        indicesToCite.add(i);
      }
    }

    // Priority 2: content-overlap with answer.  Find the ragChunk whose vocabulary
    // most closely matches the final answer — reliable when phrase/quote signals fail.
    if (indicesToCite.size === 0 && acAnswerTokens.size > 5) {
      let bestIdx = -1, bestScore = 0;
      ragChunks.forEach((c, i) => {
        const score = acComputeOverlap(c.content);
        if (score > bestScore && score >= 0.06) { bestScore = score; bestIdx = i; }
      });
      if (bestIdx >= 0) indicesToCite.add(bestIdx);
    }

    // Priority 3: AND query
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

    const finalConfidence = isGuided
      ? ("unverified" as const)
      : finalSpecialistResult.confidence;

    res.json({
      answer: finalAnswer,
      citations,
      sessionId,
      graphEntities: graphEntities.map((e) => e.name),
      confidence: finalConfidence,
      answerability: finalSpecialistResult.answerability,
      domain: technicalDomain,
      isGuided,
      isClarifying: false,
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
