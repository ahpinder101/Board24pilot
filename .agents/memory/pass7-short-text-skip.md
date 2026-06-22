---
name: Pass 7 short-text skip misses image-heavy pages
description: Extraction pass 7 guard skips pages with < 20 chars of pdf-parse text before the diagram gate runs, causing image-heavy installation pages to never be indexed.
---

## Rule
When modifying pass 7 or the extraction pipeline short-text skip, ensure image-heavy pages still reach the diagram gate for vision enrichment before being discarded.

## Why
Installation and lubrication pages in sewing machine manuals (e.g. p.16 of s7220c_in.pdf) contain numbered procedural steps rendered alongside technical illustrations. pdf-parse extracts < 20 chars of text from these pages because the text layout confuses it — the short-text guard at `if (!page.text || page.text.trim().length < 20) continue` fires before the vision diagram gate ever runs. Result: the entire page is skipped and never indexed, so RAG can never cite it.

## How to apply
The guard was changed to:
- Check `hasEmbeddedImages` (from `imagePageNumbers` set, populated from manualPages.hasImages).
- If `isShortText && !hasEmbeddedImages` → skip (unchanged behaviour for text-free pages with no images).
- If `isShortText && hasEmbeddedImages` → fall through to the diagram gate.
- If vision returns nothing AND text is still short → skip.

Re-running pass 7 for any manual with previously-skipped pages will now properly index them via vision enrichment.
