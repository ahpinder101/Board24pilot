---
name: Vision OCR and Pass 7 page scoping
description: Key rules for passVisionOcr signature, sparse-page detection, and Pass 7 stale-chunk avoidance.
---

## passVisionOcr signature
Takes `pageNumbers: number[]`, NOT `totalPages: number`. Loop is over that array, not 1..N.
Call sites must pass an array: `pdfContent.pages.map(p => p.pageNumber)` or sparse-page subset.

**Why:** Original signature processed all pages 1..totalPages regardless of page range filter, wasting Vision OCR API calls and ignoring partial-run scoping.

## Sparse-page Vision OCR (per-page, not ratio)
The old 80% empty-page ratio for `isImageBasedPdf` was replaced with a per-page filter:
```typescript
const sparsePages = pdfContent.pages.filter((p) => !p.text || p.text.trim().length < 20);
const sparsePageNums = sparsePages.map((p) => p.pageNumber);
if (sparsePageNums.length > 0) { ... passVisionOcr(manualId, pdfBuffer, sparsePageNums) }
```

**Why:** Mixed-format PDFs (part text, part scanned diagrams — the common case for engineering manuals) fell below 80% threshold and got no Vision OCR on their scanned pages. Now every sparse page gets OCR'd individually regardless of the document's overall ratio.

## Pass 7 stale chunk guard
`pass7EmbedChunks` has a resume path: if `chunkedPageSet.size > 0` it skips already-indexed pages. For partial re-runs this means old chunks from a prior full-doc run survive even after Vision OCR rewrote rawText.

Fix is inside `pass7EmbedChunks` itself: before the resume check, compare the requested page list against existing chunks; if it's a partial overlap (some pages have chunks, some don't, and the requested pages are a subset), delete chunks for only the requested pages first.

```
existingInRange.length > 0 && existingInRange.length < existingForRange.length
→ delete chunks for those pages → let resume logic re-index them fresh
```

## rechunkManual must clear chunks first
`rechunkManual` calls `pass7EmbedChunks` without a pdfBuffer (no diagram gate). If chunks already exist, every page is in `chunkedPageSet` and the whole function becomes a no-op. Fix: `await db.delete(chunksTable).where(eq(chunksTable.manualId, manualId))` before calling pass7EmbedChunks, forcing the fresh-run path.
