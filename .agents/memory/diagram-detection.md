---
name: Diagram detection midtone heuristic
description: Validated pixel metric for identifying embedded wiring diagrams / schematics vs photos in PDF pages, used in Pass 7 to auto-trigger vision OCR.
---

## The rule

**Midtone pixel fraction < 25% → diagram/schematic → replace OCR with vision description.**

Midtone = pixels with luminance 80–180 (where luminance = (R+G+B)/3, after flattening alpha to white background).

## Why midtone works better than simple binary threshold

The initial idea (count near-black <60 + near-white >200 pixels) failed because wiring diagrams in scanned PDFs are JPEG-compressed, creating gray edge-pixels. A <60 threshold missed ~50% of diagram pixels.

Midtone fraction inverts the question: measure what fraction of pixels are in the *middle* luminance band. Diagrams are bimodal (ink + paper), so almost nothing falls in the middle. Photos of metal machines have gradients, shadows, reflections — all mid-luminance.

## Empirical validation (Warco WM-12 manual, 18 extracted images)

| Image type | midtone% |
|---|---|
| Wiring diagram (img-011, page 10) | **8%** |
| Parts assembly drawing (img-017, page 14) | **9%** |
| Machine photos (typical) | 40–86% |
| Control panel photo | 41% |

Natural gap: nothing in this document fell between 15% and 40%. Threshold of 25% is conservative — well below all photos, well above all diagrams.

**Why:** Simple binary threshold at luminance <60/>200 scored the wiring diagram at only 53% (JPEG artifacts). Midtone inversion scored it at 8% — unambiguous.

## How to apply

- `hasDiagramImage(pdfBuffer, pageNumber)` in `pdfExtractor.ts` uses `pdfimages` + `sharp` to check every embedded image on a page
- Called in `pass7EmbedChunks` when `pdfBuffer` is provided (main pipeline passes it; `rechunkManual` doesn't have the buffer so it skips this gate gracefully)
- Diagram pages get `describePageWithVision()` output instead of garbled OCR text
- The vision prompt (`buildPageInterpretationPrompt`) classifies the page type and applies the relevant ISO/IEC standard (IEC 60617 for electrical wiring, ISO 1219 for pneumatics, etc.)

## sharp is already declared

`sharp: ^0.34.3` is a `dependency` in `@workspace/api-server/package.json` — no `pnpm add` needed.
