import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

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

/**
 * Returns true if any embedded image on `pageNumber` has a low midtone pixel
 * fraction, which is a reliable signal for line drawings, wiring diagrams,
 * schematics, and assembly drawings.
 *
 * Metric: pixels whose luminance falls in the 80–180 range ("midtones").
 * Diagrams are bimodal — nearly all pixels are near-black ink or near-white
 * paper, so midtone% < 25%.  Photos of metal machinery are dominated by
 * gradients, shadows, and reflections, all in the mid-luminance band, so
 * midtone% > 40%.  The empirical gap (validated on Warco WM-12 manual) makes
 * 25% a robust threshold with no observed false positives.
 *
 * Uses pdfimages to extract embedded raster images, then sharp for pixel
 * analysis.  Returns false on any extraction error so the caller degrades
 * gracefully.
 */
export async function hasDiagramImage(
  pdfBuffer: Buffer,
  pageNumber: number
): Promise<boolean> {
  const tempDir = await mkdtemp(join(tmpdir(), "pdfdiag-"));
  const pdfPath = join(tempDir, "input.pdf");
  const outPrefix = join(tempDir, "img");

  try {
    await writeFile(pdfPath, pdfBuffer);
    await execFileAsync("pdfimages", [
      "-f", String(pageNumber),
      "-l", String(pageNumber),
      "-png",
      pdfPath,
      outPrefix,
    ]);

    const files = await readdir(tempDir);
    const pngs = files.filter((f) => f.endsWith(".png"));
    if (pngs.length === 0) return false;

    for (const file of pngs) {
      const { data, info } = await sharp(join(tempDir, file))
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const totalPixels = info.width * info.height;
      const ch = info.channels;
      let midtoneCount = 0;

      for (let i = 0; i < data.length; i += ch) {
        const lum = ((data[i] ?? 255) + (data[i + 1] ?? 255) + (data[i + 2] ?? 255)) / 3;
        if (lum >= 80 && lum <= 180) midtoneCount++;
      }

      if (midtoneCount / totalPixels < 0.25) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Writes pdfBuffer to a single shared temp file and returns the path plus a
 * cleanup function.  Call once per pipeline pass so the buffer is written to
 * disk only once regardless of how many pages are subsequently examined.
 */
export async function writePdfToTempFile(
  pdfBuffer: Buffer,
): Promise<{ pdfPath: string; cleanup: () => Promise<void> }> {
  const tempDir = await mkdtemp(join(tmpdir(), "pdfshared-"));
  const pdfPath = join(tempDir, "manual.pdf");
  await writeFile(pdfPath, pdfBuffer);
  return {
    pdfPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Path-based variant of hasDiagramImage.
 * Caller manages the PDF file lifetime; this function does NOT write the PDF.
 * Use when checking many pages of the same PDF to avoid re-writing on every call.
 */
export async function hasDiagramImageFromPath(
  pdfPath: string,
  pageNumber: number,
): Promise<boolean> {
  const tempDir = await mkdtemp(join(tmpdir(), "pdfdiag-"));
  const outPrefix = join(tempDir, "img");

  try {
    await execFileAsync("pdfimages", [
      "-f", String(pageNumber),
      "-l", String(pageNumber),
      "-png",
      pdfPath,
      outPrefix,
    ]);

    const files = await readdir(tempDir);
    const pngs = files.filter((f) => f.endsWith(".png"));
    if (pngs.length === 0) return false;

    for (const file of pngs) {
      const { data, info } = await sharp(join(tempDir, file))
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const totalPixels = info.width * info.height;
      const ch = info.channels;
      let midtoneCount = 0;

      for (let i = 0; i < data.length; i += ch) {
        const lum = ((data[i] ?? 255) + (data[i + 1] ?? 255) + (data[i + 2] ?? 255)) / 3;
        if (lum >= 80 && lum <= 180) midtoneCount++;
      }

      if (midtoneCount / totalPixels < 0.25) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Path-based variant of renderPdfPageToBase64.
 * Caller manages the PDF file lifetime; this function does NOT write the PDF.
 * Use when rendering many pages of the same PDF to avoid re-writing on every call.
 */
export async function renderPdfPageToBase64FromPath(
  pdfPath: string,
  pageNumber: number,
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "pdfrender-"));
  const outputPrefix = join(tempDir, "pg");

  try {
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

/**
 * Runs `pdfimages -list` on a PDF file and returns the set of page numbers
 * that contain at least one embedded raster image.
 *
 * This is the authoritative source for hasImages — it reads the PDF's internal
 * image XObject table directly, with no text-length heuristic involved.
 * Costs one subprocess call for the whole document (not per page).
 */
export async function getImagePageNumbers(pdfPath: string): Promise<Set<number>> {
  const imagePages = new Set<number>();
  try {
    const { stdout } = await execFileAsync("pdfimages", ["-list", pdfPath]);
    for (const line of stdout.split("\n").slice(2)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length > 1 && /^\d+$/.test(parts[0])) {
        imagePages.add(parseInt(parts[0], 10));
      }
    }
  } catch {
    // pdfimages unavailable or PDF has no images — returns empty set,
    // which means hasImages=false for all pages (safe: no vision gate fires).
  }
  return imagePages;
}

export async function extractPdfText(pdfBuffer: Buffer): Promise<PdfContent> {
  const pdfParse = await import("pdf-parse");
  const parse = pdfParse.default;

  // Run pdfimages -list once on the whole document to get authoritative image
  // page numbers. We write a short-lived temp file just for this scan; it is
  // cleaned up before the function returns.
  let scanTempDir: string | undefined;
  let imagePageNumbers = new Set<number>();
  try {
    scanTempDir = await mkdtemp(join(tmpdir(), "pdfimgscan-"));
    const scanPath = join(scanTempDir, "input.pdf");
    await writeFile(scanPath, pdfBuffer);
    imagePageNumbers = await getImagePageNumbers(scanPath);
  } catch {
    // If the temp write fails for any reason, fall back to empty set (safe).
  } finally {
    if (scanTempDir) {
      await rm(scanTempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

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
        const hasImages = imagePageNumbers.has(currentPage);
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

  // ── Pass 5: enrich spec-table chunks with canonical measurement vocabulary ─
  //
  // WHY THIS EXISTS:
  //   FTS is lexical — it only retrieves chunks whose stored text contains the
  //   words from the query.  Engineering spec tables contain no prose: just
  //   column letters (A B C), units (mm, Kg, kW), and numbers (230, 268, 416).
  //   A question using any natural-language measurement word ("height",
  //   "clearance", "suction capacity", "operating temperature") will miss the
  //   table chunk unless that word appears in its section heading.
  //
  //   The fix must be at WRITE TIME, not query time.  We detect chunks that are
  //   primarily tabular (high ratio of numeric/unit lines) and append a
  //   standardised vocabulary tag so that every spec table is discoverable from
  //   any measurement-type question, with no per-question synonym rules needed.
  //
  // DETECTION HEURISTIC — token-based, not character-class:
  //   A token is "spec-like" if it is:
  //     • Purely numeric (integers, decimals, ranges like 0,15): /^\d+([.,]\d+)*$/
  //     • A short alphanumeric token (≤4 chars) likely to be a unit or column
  //       letter: mm, cm, kg, kW, Hz, V, L, A-Z single letter, mc/h, 4mc, …
  //     • A combined dimension string: 324x60x250, 230V/50Hz
  //   A line is "tabular" if it has ≥ 2 tokens and ≥ 50 % are spec-like.
  //   A chunk is a spec table if ≥ 35 % of its non-empty lines are tabular
  //   AND it has ≥ 3 lines.

  /**
   * Returns true if a whitespace-separated token looks like a numeric spec value,
   * a dimension label, or an SI unit abbreviation.  Deliberately excludes common
   * short English words ("the", "and", "knob", "bar") that the old catch-all
   * ≤4-char rule was matching.
   */
  function isSpecToken(tok: string): boolean {
    if (!tok) return false;
    // Pure number (integer or decimal, comma/dot separator): 230, 0.25, 1,5
    if (/^\d+([.,]\d+)*$/.test(tok)) return true;
    // Number with optional leading ± and a unit suffix: 230V, 0.25kW, 50Hz, ±1mm
    if (/^[±]?\d+([.,x×]\d+)*[A-Za-z°%/]*$/.test(tok) && tok.length <= 12) return true;
    // Compound dimension strings: 324x60x250, 60×60, 230/50Hz
    if (/^\d+[x×/]\d+/.test(tok)) return true;
    // Single uppercase letter — column/dimension label in a figure: A, B, C … Z
    if (/^[A-Z]$/.test(tok)) return true;
    // Common engineering / SI unit abbreviations (exact match, case-insensitive)
    if (
      /^(mm|cm|dm|m|km|g|kg|mg|kw|w|mw|mw|kwh|wh|hz|khz|mhz|rpm|bar|kpa|mpa|pa|nm|°c|°f|m3|dm3|l|ml|kva|va|kv|mv|ma|kΩ|Ω|in|ft|lb|lbs|psi|cfm|gpm)$/i.test(
        tok,
      )
    )
      return true;
    return false;
  }

  function isTabularLine(line: string): boolean {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return false;
    const specCount = tokens.filter(isSpecToken).length;
    // Require ≥ 60 % spec-like tokens (raised from 50 %) to avoid prose lines
    // with just a number or two (e.g. section headings like "1.5 - Machine description")
    return specCount / tokens.length >= 0.6;
  }

  const SPEC_TAG =
    "\n[Specification table: technical data, dimensions, height, width, depth, length, clearance, stroke, capacity, performance, weight, measurements, specifications, ratings]";

  const enrichedChunks = finalChunks.map((chunk) => {
    const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < 3) return chunk;
    const tabularLines = lines.filter(isTabularLine);
    if (tabularLines.length / lines.length >= 0.35) {
      return chunk + SPEC_TAG;
    }
    return chunk;
  });

  // Fallback: nothing passed the length threshold — return whole filtered page.
  return enrichedChunks.length > 0
    ? enrichedChunks
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
