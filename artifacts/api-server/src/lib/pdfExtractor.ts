import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Renders a single PDF page to a base64-encoded PNG using pdftoppm.
 * Used for vision-based OCR on image-only (scanned) PDFs.
 */
export async function renderPdfPageToBase64(
  pdfBuffer: Buffer,
  pageNumber: number
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "pdfrender-"));
  const pdfPath = join(tempDir, "input.pdf");
  const outputPrefix = join(tempDir, "pg");

  try {
    await writeFile(pdfPath, pdfBuffer);

    // -r 150: 150 DPI — good quality for OCR without oversized images
    await execFileAsync("pdftoppm", [
      "-r", "150",
      "-f", String(pageNumber),
      "-l", String(pageNumber),
      "-png",
      pdfPath,
      outputPrefix,
    ]);

    const files = await readdir(tempDir);
    const pngFile = files.find((f) => f.endsWith(".png"));
    if (!pngFile) throw new Error(`pdftoppm produced no PNG for page ${pageNumber}`);

    const imageBuffer = await readFile(join(tempDir, pngFile));
    return imageBuffer.toString("base64");
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface PageContent {
  pageNumber: number;
  text: string;
  hasImages: boolean;
  hasTables: boolean;
}

export interface PdfContent {
  totalPages: number;
  pages: PageContent[];
  fullText: string;
}

export async function extractPdfText(pdfBuffer: Buffer): Promise<PdfContent> {
  const pdfParse = await import("pdf-parse");
  const parse = pdfParse.default;

  const pages: PageContent[] = [];
  let currentPage = 0;

  const data = await parse(pdfBuffer, {
    pagerender: (pageData: any) => {
      return pageData.getTextContent().then((textContent: any) => {
        let text = "";
        let lastY: number | undefined;
        for (const item of textContent.items) {
          if (lastY !== item.transform[5] && lastY !== undefined) {
            text += "\n";
          }
          text += item.str;
          lastY = item.transform[5];
        }

        currentPage++;
        const hasImages = text.length < 100 && currentPage > 1;
        const hasTables = /(\t|  {3,})/.test(text) || /\|.*\|/.test(text);

        pages.push({
          pageNumber: currentPage,
          text: text.trim(),
          hasImages,
          hasTables,
        });

        return text;
      });
    },
  });

  return {
    totalPages: data.numpages,
    pages,
    fullText: data.text,
  };
}

// ─── Semantic page chunker ────────────────────────────────────────────────────
//
// WHY NOT character-count or paragraph-break splitting:
//
//   PDF-extracted text from procedural engineering manuals has NO blank lines
//   between steps.  `text.split(/\n\n+/)` returns the entire page as a single
//   paragraph, and character-count cutting produces mid-word fragments.  Both
//   strategies destroy the locality of label ↔ value pairs, e.g. the validity
//   scope "Valid only for Sq machines" ends up in a different chunk from the
//   values table "C (mm) D (mm) / 300 ±1  110 ±1" that belongs to it.
//
// THE RIGHT BOUNDARY:
//
//   Procedural manuals are structured around alphabetic step markers (a), b),
//   e), f), g) …).  Each step is a complete semantic unit — it contains its
//   own procedure text, sub-steps (Basic setting / Fine setting), component
//   legend, and trailing values table.  Numbered section headers (1.1, 2.3 …)
//   serve the same role in longer manuals.
//
// SCOPE INHERITANCE:
//
//   Validity-scope lines ("Valid only for Sq machines", "Not valid for Sq
//   machines", "Valid for all machines") are NOT split points.  They are
//   inherited context, prepended to *every* chunk that follows on the page.
//   This guarantees that a numeric table always carries the machine-type
//   discriminator regardless of where it falls, making it FTS-retrievable
//   and self-interpreting for the LLM.
//
// BOILERPLATE FILTERING:
//
//   Document header noise (page labels, doc numbers, brand name, continuation
//   markers) that repeats on every page is stripped before chunking so it
//   does not dilute FTS token vectors.

/** Lines that appear on every page header/footer — document noise with no retrieval value. */
const BOILERPLATE: RegExp[] = [
  /^FF\s+Synchronis/i,              // "FF Synchronisation"
  /^SI-\d+$/,                       // page labels e.g. "SI-6"
  /^Doc\s+No\./i,                   // "Doc No. MM-…"
  /^\d+\.\d+[A-Za-z0-9]+\.fm$/i,   // file refs e.g. "2.2B291XE00.fm"
  /^Te(\s+[a-z])+\s+P/i,           // "Te t r a   Pa k" / "Te t r a   P a k"
  /^Supplementary\s+instructions$/i,
  /^\(Cont\.?'?d\)$/i,              // "(Cont'd)"
  /^Maintenance\s+Manual$/i,
  /^Supplement\s+to\s+MM-/i,
  /^\d+$/,                          // standalone diagram ref numbers (15, 16 …)
  /^[A-Z]$/,                        // single-letter diagram annotations (C, D, A …)
];

/**
 * Validity-scope discriminators.  The captured group becomes the scope label
 * prepended to all subsequent chunks on the page.
 */
const SCOPE_RE: RegExp[] = [
  /^(valid\s+only\s+for\s+.+)$/i,
  /^(not\s+valid\s+for\s+.+)$/i,
  /^(valid\s+for\s+all\s+machines[^.]*)$/i,
];

/** Alphabetic step marker at line start: "e)   …", "f)Basic…", "g)…" */
const STEP_RE = /^[a-z]\)\s*/;

/** Numbered section header for longer manuals: "1.1 Title", "2.3.4 …" */
const NUMBERED_SECTION_RE = /^\d+(\.\d+)+\s+\S/;

function isStepBoundary(line: string): boolean {
  return STEP_RE.test(line) || NUMBERED_SECTION_RE.test(line);
}

/**
 * Splits one page's raw text into semantically complete chunks.
 *
 * Each output chunk:
 *  - Begins with the page's validity-scope label (if any), so the LLM always
 *    knows which machine type the content applies to.
 *  - Corresponds to one complete procedure step (a–z) or numbered section,
 *    including all sub-steps, component labels, and trailing tables.
 *  - Falls back to blank-line splitting for narrative pages without step markers.
 *  - Falls back to the whole filtered page if no other boundary is found.
 *  - Is capped at 1 500 chars; oversized units are split at sentence/line
 *    boundaries (never mid-word) with the scope label repeated on each piece.
 */
export function chunkPageSemantically(pageText: string): string[] {
  if (!pageText?.trim()) return [];

  const lines = pageText.split("\n").map((l) => l.trim()).filter(Boolean);

  // ── Pass 1: strip boilerplate, detect validity scope ─────────────────────
  let scopeLabel = "";
  const contentLines: string[] = [];

  for (const line of lines) {
    if (BOILERPLATE.some((re) => re.test(line))) continue;

    let isScope = false;
    for (const re of SCOPE_RE) {
      const m = re.exec(line);
      if (m) {
        scopeLabel = m[1]!;
        isScope = true;
        break;
      }
    }
    if (isScope) continue; // scope captured — do not include as content

    contentLines.push(line);
  }

  if (contentLines.length === 0) return [];

  // ── Pass 2: split at semantic boundaries ─────────────────────────────────
  const hasStepMarkers = contentLines.some((l) => isStepBoundary(l));
  let units: string[][];

  if (hasStepMarkers) {
    // Primary strategy: each alphabetic/numeric step starts a new chunk unit.
    units = [[]];
    for (const line of contentLines) {
      if (isStepBoundary(line) && units[units.length - 1]!.length > 0) {
        units.push([line]);
      } else {
        units[units.length - 1]!.push(line);
      }
    }
  } else {
    // Fallback: blank-line split (PDF text uses single \n, so re-join first).
    const rejoined = contentLines.join("\n");
    const paras = rejoined.split(/\n{2,}/);
    units = paras.map((p) => p.split("\n").filter(Boolean));
  }

  // ── Pass 3: assemble chunks with scope prefix ─────────────────────────────
  const prefix = scopeLabel ? `[${scopeLabel}]\n` : "";
  const rawChunks: string[] = [];

  for (const unit of units) {
    const text = unit.join("\n").trim();
    if (text.length < 15) continue; // skip trivial fragments
    rawChunks.push(prefix + text);
  }

  // ── Pass 4: cap at 1 500 chars, split at line/sentence boundaries ─────────
  const MAX_CHUNK = 1500;
  const finalChunks: string[] = [];

  for (const chunk of rawChunks) {
    if (chunk.length <= MAX_CHUNK) {
      finalChunks.push(chunk);
      continue;
    }
    // Split at sentence endings or newlines; carry scope prefix on each piece.
    const parts = chunk.split(/(?<=\.)\s+|\n/);
    let current = "";
    for (const part of parts) {
      const candidate = current ? `${current}\n${part}` : part;
      if (candidate.length > MAX_CHUNK && current) {
        finalChunks.push(current.trim());
        current = scopeLabel ? `[${scopeLabel}]\n${part}` : part;
      } else {
        current = candidate;
      }
    }
    if (current.trim()) finalChunks.push(current.trim());
  }

  // Fallback: nothing passed the length threshold — return whole filtered page.
  return finalChunks.length > 0
    ? finalChunks
    : [prefix + contentLines.join("\n")];
}

/**
 * Splits arbitrary long text into chunks at paragraph boundaries.
 * Used for Pass 4/5 entity+relationship extraction (not stored in DB —
 * these are just context windows for AI inference calls).
 */
export function chunkText(text: string, maxChunkSize = 6000): string[] {
  if (text.length <= maxChunkSize) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > maxChunkSize && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
