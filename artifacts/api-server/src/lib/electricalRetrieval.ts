import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { containsDomainIdentifier } from "./domainSpecialist.js";
import {
  INTERCONNECT_QUERY_RE,
  isInterconnectQuestion,
  isPlcIoQuestion,
  PLC_IO_QUERY_RE,
  relationshipTraceSeeds,
  TROUBLESHOOTING_COMPONENT_KEYWORDS,
  troubleshootingComponentSymbols,
} from "./queryIntent.js";

export type ElectricalChunkRow = {
  id: number;
  manual_id: number;
  manual_name: string;
  page_number: number;
  chunk_index: number;
  content: string;
  rank: number;
  section_path?: string | null;
  element_type?: string | null;
  page_context?: string | null;
};

type SymbolFetchOptions = {
  /** Expand adjacent pages by this delta (0 = same page only). */
  adjacentPageDelta?: number;
};

export async function fetchElectricalSymbolChunks(
  scopedManualArray: string,
  symbols: string[],
  question: string,
  options: SymbolFetchOptions = {},
): Promise<ElectricalChunkRow[]> {
  if (symbols.length === 0) return [];

  const adjacentDelta = options.adjacentPageDelta ?? 0;

  const symbolConditions = symbols.map(
    (symbol) =>
      sql`(c.content ILIKE ${"%" + symbol + "%"} OR COALESCE(c.page_context, '') ILIKE ${"%" + symbol + "%"})`,
  );
  const symbolHits = await db.execute<ElectricalChunkRow>(sql`
    SELECT c.id, c.manual_id, m.name AS manual_name,
           c.page_number, c.chunk_index, c.content,
           c.section_path, c.element_type, c.page_context,
           (
             CASE WHEN c.element_type = 'table' THEN 0.35 ELSE 0 END +
             CASE WHEN c.page_context IS NOT NULL THEN 0.15 ELSE 0 END +
             CASE WHEN ${containsDomainIdentifier(question)} THEN 0.1 ELSE 0 END
           )::float AS rank
    FROM chunks c JOIN manuals m ON m.id = c.manual_id
    WHERE c.manual_id = ANY(${scopedManualArray}::integer[])
      AND (${sql.join(symbolConditions, sql` OR `)})
    ORDER BY rank DESC, c.page_number, c.chunk_index
    LIMIT 24
  `);

  if (symbolHits.rows.length === 0) return [];

  const merged = [...symbolHits.rows];
  const existingIds = new Set(merged.map((row) => row.id));
  const pageKeys = new Set<string>();
  const pageContextValues = new Set<string>();
  for (const row of symbolHits.rows) {
    pageKeys.add(`${row.manual_id}:${row.page_number}`);
    if (row.page_context) pageContextValues.add(row.page_context);
    if (adjacentDelta > 0) {
      for (let d = -adjacentDelta; d <= adjacentDelta; d++) {
        if (d === 0) continue;
        const adj = row.page_number + d;
        if (adj > 0) pageKeys.add(`${row.manual_id}:${adj}`);
      }
    }
  }

  if (pageKeys.size > 0 || pageContextValues.size > 0) {
    const pageClauses = [...pageKeys].map((key) => {
      const [mid, pg] = key.split(":").map(Number);
      return sql`(c.manual_id = ${mid} AND c.page_number = ${pg})`;
    });
    const pageContextClauses = [...pageContextValues].map(
      (pageContext) => sql`c.page_context = ${pageContext}`,
    );
    const expansionClauses = [...pageClauses, ...pageContextClauses];
    if (expansionClauses.length > 0) {
      const expandedHits = await db.execute<ElectricalChunkRow>(sql`
        SELECT c.id, c.manual_id, m.name AS manual_name,
               c.page_number, c.chunk_index, c.content,
               c.section_path, c.element_type, c.page_context,
               (
                 CASE WHEN c.element_type = 'table' THEN 0.2 ELSE 0 END +
                 CASE WHEN c.page_context IS NOT NULL THEN 0.05 ELSE 0 END
               )::float AS rank
        FROM chunks c JOIN manuals m ON m.id = c.manual_id
        WHERE c.manual_id = ANY(${scopedManualArray}::integer[])
          AND (${sql.join(expansionClauses, sql` OR `)})
        ORDER BY c.page_number, c.chunk_index
        LIMIT 48
      `);
      for (const row of expandedHits.rows) {
        if (!existingIds.has(row.id)) {
          merged.push(row);
          existingIds.add(row.id);
        }
      }
    }
  }

  return merged;
}

export async function fetchPlcIoTableChunks(
  scopedManualArray: string,
  question: string,
): Promise<ElectricalChunkRow[]> {
  if (!isPlcIoQuestion(question)) return [];

  const plcAddrFromQuestion = [
    ...question.matchAll(/\b[XYI][0-9]+[.:][0-9]{1,2}\b/gi),
  ].map((m) => m[0]!.toUpperCase());

  const addrConditions = plcAddrFromQuestion.map(
    (addr) => sql`c.content ILIKE ${"%" + addr + "%"}`,
  );

  const tagCondition = sql`c.content LIKE ${"%[PLC I/O assignment%"}`;
  const whereClause =
    addrConditions.length > 0
      ? sql`(${tagCondition} OR ${sql.join(addrConditions, sql` OR `)})`
      : tagCondition;

  const result = await db.execute<ElectricalChunkRow>(sql`
    SELECT c.id, c.manual_id, m.name AS manual_name,
           c.page_number, c.chunk_index, c.content,
           c.section_path, c.element_type, c.page_context,
           0.5::float AS rank
    FROM chunks c JOIN manuals m ON m.id = c.manual_id
    WHERE c.manual_id = ANY(${scopedManualArray}::integer[])
      AND ${whereClause}
    ORDER BY c.page_number, c.chunk_index
    LIMIT 8
  `);

  return result.rows;
}

export async function fetchInterconnectChunks(
  scopedManualArray: string,
  question: string,
): Promise<ElectricalChunkRow[]> {
  if (!isInterconnectQuestion(question)) return [];

  const patterns = ["interconnect", "terminal block", "terminal strip", "XT", "TB", "core"];
  for (const m of question.matchAll(/\b(?:XT|TB)\d+[A-Z]?\b/gi)) {
    patterns.push(m[0]!.toUpperCase());
  }

  const conditions = patterns.map((p) => sql`c.content ILIKE ${"%" + p + "%"}`);
  const titleBlockCondition = sql`c.content ILIKE ${"%DRAWING NO:%"}`;

  const result = await db.execute<ElectricalChunkRow>(sql`
    SELECT c.id, c.manual_id, m.name AS manual_name,
           c.page_number, c.chunk_index, c.content,
           c.section_path, c.element_type, c.page_context,
           0.4::float AS rank
    FROM chunks c JOIN manuals m ON m.id = c.manual_id
    WHERE c.manual_id = ANY(${scopedManualArray}::integer[])
      AND (${sql.join([...conditions, titleBlockCondition], sql` OR `)})
    ORDER BY c.page_number, c.chunk_index
    LIMIT 10
  `);

  return result.rows;
}

export async function fetchTroubleshootingComponentChunks(
  scopedManualArray: string,
  question: string,
): Promise<ElectricalChunkRow[]> {
  const symbols = troubleshootingComponentSymbols(question);
  const symbolChunks = await fetchElectricalSymbolChunks(scopedManualArray, symbols, question);

  const keywordConditions = TROUBLESHOOTING_COMPONENT_KEYWORDS.map(
    (kw) => sql`c.content ILIKE ${"%" + kw + "%"}`,
  );

  const keywordHits = await db.execute<ElectricalChunkRow>(sql`
    SELECT c.id, c.manual_id, m.name AS manual_name,
           c.page_number, c.chunk_index, c.content,
           c.section_path, c.element_type, c.page_context,
           0.25::float AS rank
    FROM chunks c JOIN manuals m ON m.id = c.manual_id
    WHERE c.manual_id = ANY(${scopedManualArray}::integer[])
      AND (${sql.join(keywordConditions, sql` OR `)})
    ORDER BY c.page_number, c.chunk_index
    LIMIT 16
  `);

  const merged = [...symbolChunks];
  const existingIds = new Set(merged.map((r) => r.id));
  for (const row of keywordHits.rows) {
    if (!existingIds.has(row.id)) {
      merged.push(row);
      existingIds.add(row.id);
    }
  }
  return merged;
}

export async function fetchRelationshipTraceChunks(
  scopedManualArray: string,
  question: string,
): Promise<ElectricalChunkRow[]> {
  const seeds = relationshipTraceSeeds(question);
  if (seeds.length === 0) {
    seeds.push("E-STOP", "KM");
  }
  return fetchElectricalSymbolChunks(scopedManualArray, seeds, question, {
    adjacentPageDelta: 2,
  });
}

/** Re-export for tests / callers that need the regex. */
export { PLC_IO_QUERY_RE, INTERCONNECT_QUERY_RE };
