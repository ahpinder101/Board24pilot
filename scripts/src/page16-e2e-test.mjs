/**
 * End-to-end test for S7220C page 16 — "2-3. Lubrication"
 * Runs: Docling extraction → all 7 pipeline passes → live LLM calls
 * Usage: node scripts/src/page16-e2e-test.mjs
 */
import { execSync } from "node:child_process";
import OpenAI from "openai";

const TARGET_MANUAL_ID = 19;
const TARGET_PAGE = 16;
const DOCLING_URL = "http://localhost:8000/docling-api/extract";

const HR  = "═".repeat(72);
const hdr = (n, title) => `\n${HR}\n  PASS ${n}: ${title}\n${HR}`;

const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Run psql query, return rows as array of objects */
function psql(sql) {
  const out = execSync(
    `psql "${process.env.DATABASE_URL}" -c "${sql.replace(/"/g, '\\"')}" --csv --no-psqlrc -q`,
    { maxBuffer: 20_000_000 }
  ).toString().trim();
  if (!out) return [];
  const lines = out.split("\n");
  const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g, ""));
  return lines.slice(1).map(line => {
    // Minimal CSV parse — handles quoted fields with embedded newlines won't work
    // but good enough for single-row DB values here
    const vals = line.match(/("(?:[^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0);
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] ?? "").replace(/^"|"$/g, "").replace(/""/g, '"')]));
  });
}

/** Fetch PDF bytes from DB via psql hex output */
function fetchPdfBytes() {
  const out = execSync(
    `psql "${process.env.DATABASE_URL}" -c "SELECT encode(pdf_data,'hex') as h FROM manuals WHERE id=${TARGET_MANUAL_ID}" --csv --no-psqlrc -q`,
    { maxBuffer: 50_000_000 }
  ).toString().trim();
  const hex = out.split("\n")[1]; // skip header
  return Buffer.from(hex, "hex");
}

async function main() {
  // ── Pre-fetch metadata from DB ───────────────────────────────────────────
  const [manual]   = psql(`SELECT id, filename, document_type, structure::text as structure, total_pages FROM manuals WHERE id=${TARGET_MANUAL_ID}`);
  const [page16db] = psql(`SELECT page_number, COALESCE(printed_page_number,'(null)') as printed_page_number, has_images, has_tables, LENGTH(raw_text) as raw_len, raw_text, COALESCE(description,'') as description FROM manual_pages WHERE manual_id=${TARGET_MANUAL_ID} AND page_number=${TARGET_PAGE}`);
  const chunks16   = psql(`SELECT id, page_number, LENGTH(content) as len, content FROM chunks WHERE manual_id=${TARGET_MANUAL_ID} AND page_number=${TARGET_PAGE} ORDER BY id`);
  const rels       = psql(`SELECT r.type, r.label, se.name as source, te.name as target FROM relationships r JOIN entities se ON se.id=r.source_entity_id JOIN entities te ON te.id=r.target_entity_id WHERE r.manual_id=${TARGET_MANUAL_ID} LIMIT 12`);

  const structure = JSON.parse(manual.structure);
  const rawLen    = parseInt(page16db.raw_len);

  console.log(`\n${"▓".repeat(72)}`);
  console.log(`  S-7220C · Page ${TARGET_PAGE} · End-to-End Pipeline Test`);
  console.log(`${"▓".repeat(72)}`);
  console.log(`  Manual ID     : ${manual.id}  (${manual.filename})`);
  console.log(`  Document type : ${manual.document_type}`);
  console.log(`  Total pages   : ${manual.total_pages}`);

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 1
  // ══════════════════════════════════════════════════════════════════════════
  console.log(hdr(1, "Document Structure  [SAVED — no new LLM call needed]"));
  console.log(`  Document type : ${manual.document_type}`);
  console.log(`  Overview      : ${structure.overview}`);
  console.log(`  Machines      : ${structure.machines.join(" · ")}`);
  console.log(`  Sections      :`);
  for (const s of structure.sections) console.log(`    • ${s}`);
  console.log(`\n  HOW IT WORKS:`);
  console.log(`    Input  → first 8,000 chars of full document text`);
  console.log(`    Output → documentType, overview, machines[], sections[]`);
  console.log(`    Saved  → manuals.structure (JSONB) + manuals.document_type`);
  console.log(`    Cost   → 1 LLM call per manual (run once, cached on resume)`);

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 2
  // ══════════════════════════════════════════════════════════════════════════
  console.log(hdr(2, "Per-Page Content Storage  [NO LLM — pure DB write]"));
  console.log(`  Page ${TARGET_PAGE} stored in manual_pages:`);
  console.log(`    printed_page_number : ${page16db.printed_page_number}`);
  console.log(`    has_images          : ${page16db.has_images}`);
  console.log(`    has_tables          : ${page16db.has_tables}`);
  console.log(`    raw_text length     : ${rawLen} chars`);
  console.log(`\n  raw_text[:300]:`);
  console.log(`    ${page16db.raw_text.slice(0, 300).replace(/\n/g, "\n    ")}`);
  console.log(`\n  HOW IT WORKS:`);
  console.log(`    Input  → all pages from pdf-parse or Docling`);
  console.log(`    Output → rows in manual_pages (batch 20 at a time)`);
  console.log(`    Stores → rawText, hasImages, hasTables, printedPageNumber (Docling)`);
  console.log(`    NOTE   → printed_page_number=null here (processed BEFORE Docling)`);

  // ══════════════════════════════════════════════════════════════════════════
  //  DOCLING LIVE RUN
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${HR}`);
  console.log(`  DOCLING EXTRACTION  [LIVE — sending PDF to localhost:8000]`);
  console.log(HR);

  let doclingPage16 = null;
  console.log(`  Fetching PDF bytes from DB...`);
  const pdfBuf = fetchPdfBytes();
  console.log(`  PDF size: ${pdfBuf.length.toLocaleString()} bytes`);
  console.log(`  Sending to Docling sidecar...`);

  const formData = new FormData();
  formData.append("file", new Blob([pdfBuf], { type: "application/pdf" }), "s7220c_in.pdf");
  const resp = await fetch(DOCLING_URL, { method: "POST", body: formData });
  if (resp.ok) {
    const data = await resp.json();
    doclingPage16 = data.pages?.find(p => p.pageNumber === TARGET_PAGE);
    console.log(`  ✓ Docling returned ${data.totalPages} pages`);
    if (doclingPage16) {
      const byType = {};
      for (const el of (doclingPage16.elements ?? [])) byType[el.type] = (byType[el.type] || 0) + 1;

      console.log(`\n  ── Page ${TARGET_PAGE} Docling output ──`);
      console.log(`    printedPageNumber : ${doclingPage16.printedPageNumber ?? "(not detected by regex)"}`);
      console.log(`    hasImages         : ${doclingPage16.hasImages}`);
      console.log(`    hasTables         : ${doclingPage16.hasTables}`);
      console.log(`    text length       : ${doclingPage16.text?.length ?? 0} chars`);
      console.log(`    elements (${(doclingPage16.elements ?? []).length} total):`);
      for (const [t, c] of Object.entries(byType)) console.log(`      ${String(c).padStart(3)}x  ${t}`);

      console.log(`\n  ── Element breakdown (first 6 elements) ──`);
      for (const el of (doclingPage16.elements ?? []).slice(0, 6)) {
        const txt = (el.text ?? el.markdown ?? "").slice(0, 100).replace(/\n/g, "↵");
        console.log(`    [${(el.type).padEnd(16)}] lv=${el.level ?? "-"}  "${txt}"`);
      }

      console.log(`\n  ── pdf-parse vs Docling (page ${TARGET_PAGE}) ──`);
      const docLen = doclingPage16.text?.length ?? 0;
      console.log(`    pdf-parse chars  : ${rawLen}`);
      console.log(`    Docling chars    : ${docLen}   (${docLen > rawLen ? "+" : ""}${docLen - rawLen} delta)`);
      console.log(`    pdf-parse layout : flat string — no type/hierarchy info`);
      console.log(`    Docling layout   : ${Object.keys(byType).join(", ")} elements with type labels`);
      if (doclingPage16.printedPageNumber) {
        console.log(`    Printed page #   : ${doclingPage16.printedPageNumber} (from header/footer regex)`);
      }
    }
  } else {
    const err = await resp.text();
    console.log(`  Docling error ${resp.status}: ${err.slice(0, 300)}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 3
  // ══════════════════════════════════════════════════════════════════════════
  console.log(hdr(3, "Vision Descriptions  [SPARSE PAGES ONLY]"));
  if (rawLen >= 200) {
    console.log(`  Page ${TARGET_PAGE} has ${rawLen} chars — threshold is 200 → SKIPPED`);
    console.log(`  (page 16 is a rich text+image page, not a sparse/blank page)`);
  }
  if (page16db.description) {
    console.log(`\n  Existing Pass-7 vision description on page 16 (written by diagram gate):`);
    console.log(`    ${page16db.description.slice(0, 500).replace(/\n/g, "\n    ")}`);
  }
  console.log(`\n  HOW IT WORKS:`);
  console.log(`    Input  → pages where text.length < 200 AND no images`);
  console.log(`    Output → AI-generated description stored in manual_pages.description`);
  console.log(`    Cost   → 1 LLM call per sparse page (context-only, no image vision)`);

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 7
  // ══════════════════════════════════════════════════════════════════════════
  console.log(hdr(7, "RAG Text Chunking  [NO LLM — semantic split + FTS index]"));
  console.log(`  ${chunks16.length} existing chunks for page ${TARGET_PAGE}:`);
  for (const c of chunks16) {
    console.log(`\n  Chunk ${c.id} (${c.len} chars):`);
    console.log(`    ${c.content.slice(0, 300).replace(/\n/g, "\n    ")}`);
  }
  console.log(`\n  HOW IT WORKS:`);
  console.log(`    Input  → page text (or Docling elements if available)`);
  console.log(`    Output → rows in chunks table, FTS vector indexed via to_tsvector`);
  console.log(`    With Docling → buildTextFromElements() strips headers/footers,`);
  console.log(`      keeps section hierarchy, preserves tables as markdown,`);
  console.log(`      triggers vision description for picture elements`);

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 4 — LIVE LLM CALL
  // ══════════════════════════════════════════════════════════════════════════
  console.log(hdr(4, "Entity Extraction  [LIVE LLM CALL on page 16 text]"));
  const pageText = doclingPage16?.text ?? page16db.raw_text;
  console.log(`  Using ${doclingPage16 ? "Docling" : "pdf-parse"} text (${pageText.length} chars)`);
  console.log(`  Calling gpt-4o...\n`);

  let entities = [];
  const r4 = await oai.chat.completions.create({
    model: "gpt-4o",
    max_completion_tokens: 2048,
    messages: [
      {
        role: "system",
        content: `You are an expert at extracting structured knowledge from engineering manuals.
Document type: operation_manual — Brother S-7220C single needle lock stitcher.
Extract ALL distinct entities. Return JSON: { "entities": [...] }
Each entity: name, type (machine|component|subsystem|process|part|material|sensor|system|assembly|document_section), description (1-2 sentences), pageReferences, properties? ({attributes:[{value,unit,applicableTo}], conditions:[], applicableTo:[]}).`,
      },
      { role: "user", content: `Page 16 — "2-3. Lubrication":\n\n${pageText}` },
    ],
    response_format: { type: "json_object" },
  });
  entities = JSON.parse(r4.choices[0]?.message?.content ?? "{}").entities ?? [];
  console.log(`  → ${entities.length} entities extracted:`);
  for (const e of entities) {
    const attrs = (e.properties?.attributes ?? []).map(a => `${a.value}${a.unit ? " " + a.unit : ""}`).join(", ");
    console.log(`    [${e.type.padEnd(16)}] ${e.name}${attrs ? `  (${attrs})` : ""}`);
    console.log(`                       ${(e.description ?? "").slice(0, 100)}`);
  }
  console.log(`\n  Tokens: ${r4.usage.prompt_tokens}p + ${r4.usage.completion_tokens}c = ${r4.usage.total_tokens}`);

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 5b — LIVE LLM CALL
  // ══════════════════════════════════════════════════════════════════════════
  console.log(hdr("5b", "Procedural Path Extraction  [LIVE LLM CALL]"));
  console.log(`  Input: page 16 text + ${entities.length} entity names as anchors`);
  console.log(`  Calling gpt-4o...\n`);

  let paths = [];
  const entityRef = entities.length > 0
    ? `\nKNOWN ENTITIES:\n${entities.map(e => `- ${e.name} (${e.type})`).join("\n")}`
    : "";

  const r5b = await oai.chat.completions.create({
    model: "gpt-4o",
    max_completion_tokens: 2048,
    messages: [
      {
        role: "system",
        content: `Extract ALL ordered procedural sequences from this engineering manual page.
Return JSON: { "paths": [...] }
Each path: name, pathType (procedure_step|assembly_sequence|measurement_setting), condition (or null), stepSequence[], plainLanguage, pageReferences.${entityRef}`,
      },
      { role: "user", content: `Page 16 — "2-3. Lubrication":\n\n${pageText.slice(0, 2500)}` },
    ],
    response_format: { type: "json_object" },
  });
  paths = JSON.parse(r5b.choices[0]?.message?.content ?? "{}").paths ?? [];
  console.log(`  → ${paths.length} paths extracted:`);
  for (const p of paths) {
    console.log(`\n    [${(p.pathType ?? "").padEnd(22)}] "${p.name}"`);
    console.log(`      Condition : ${p.condition ?? "(none)"}`);
    for (const step of (p.stepSequence ?? []).slice(0, 5)) {
      console.log(`        • ${step.slice(0, 100)}`);
    }
    if ((p.stepSequence?.length ?? 0) > 5) console.log(`        … +${p.stepSequence.length - 5} more steps`);
    console.log(`      Summary   : ${p.plainLanguage}`);
  }
  console.log(`\n  Tokens: ${r5b.usage.prompt_tokens}p + ${r5b.usage.completion_tokens}c = ${r5b.usage.total_tokens}`);

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 5: Relationships (existing DB)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(hdr(5, "Relationship Extraction  [SAVED from previous full-doc run]"));
  if (rels.length === 0) {
    console.log(`  (no relationships stored for this manual yet)`);
  } else {
    for (const r of rels) {
      console.log(`  ${r.source.padEnd(32)} --[${r.type.padEnd(12)}]--> ${r.target}`);
      if (r.label) console.log(`    "${r.label}"`);
    }
  }
  console.log(`\n  HOW IT WORKS:`);
  console.log(`    Input  → entity list (from Pass 4) + full text chunks`);
  console.log(`    Output → rows in relationships (source_id, target_id, type, label)`);
  console.log(`    Cost   → 1 LLM call per 4,000-char text chunk`);

  // ══════════════════════════════════════════════════════════════════════════
  //  PASS 6: Ordering & hierarchy
  // ══════════════════════════════════════════════════════════════════════════
  console.log(hdr(6, "Ordering & Hierarchy  [SAVED RESULT]"));
  console.log(`  Top-level machines : ${structure.machines.join(", ")}`);
  console.log(`  Section order      : ${structure.sections.join(" → ")}`);
  console.log(`\n  HOW IT WORKS:`);
  console.log(`    Input  → entity list + first 4,000 chars of document`);
  console.log(`    Output → topLevelMachines[], procedureOrder[], hierarchyNotes`);
  console.log(`    Cost   → 1 LLM call per manual`);
  console.log(`    Used by→ graph node ordering, entities.order_index`);

  // ══════════════════════════════════════════════════════════════════════════
  //  PIPELINE SUMMARY TABLE
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${"▓".repeat(72)}`);
  console.log(`  FULL PIPELINE SUMMARY`);
  console.log(`${"▓".repeat(72)}`);
  const rows = [
    ["Pass", "Name",                     "LLM calls",              "Output for page 16"],
    ["─────","─────────────────────────","──────────────────────── ","────────────────────────────────────"],
    ["1",    "Document structure",       "1 (whole doc, once)",    `type=${manual.document_type}`],
    ["2",    "Page content storage",     "0  (pure DB write)",     `${rawLen}c text, imgs=1, tables=1`],
    ["3",    "Vision descriptions",      "0  (page not sparse)",   "SKIPPED (1910 chars > threshold)"],
    ["OCR",  "Sparse-page Vision OCR",   "0  (page has text)",     "SKIPPED (text page)"],
    ["7",    "RAG chunking + FTS index", "0  (semantic split)",    `${chunks16.length} chunks, FTS indexed`],
    ["4",    "Entity extraction",        "1 (page text)",          `${entities.length} entities`],
    ["5b",   "Procedure paths",          "1 (page text)",          `${paths.length} procedures`],
    ["5",    "Relationship mapping",     "1 (entities + text)",    `${rels.length} relationships in DB`],
    ["6",    "Ordering / hierarchy",     "1 (first 4k, once)",     "machine rank + section order"],
  ];
  const [c1, c2, c3, c4] = [6, 27, 26, 38];
  for (const [p, n, l, o] of rows) {
    console.log(`  ${p.padEnd(c1)}${n.padEnd(c2)}${l.padEnd(c3)}${o}`);
  }
  console.log(`\n  Total LLM calls for a FULL re-extraction: ~4 + (N text chunks × 3 for passes 4/5/5b)`);
  console.log(`  For S-7220C (62 pages ≈ 15 chunks): ~49 LLM calls`);
  console.log(`${"─".repeat(72)}\n`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
