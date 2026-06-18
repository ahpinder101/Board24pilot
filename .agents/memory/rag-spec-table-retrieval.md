---
name: RAG spec-table retrieval
description: How spec/dimension tables are made FTS-discoverable and why the two-step approach (write-time tag + direct read-time query) is needed.
---

## The problem
Engineering spec tables contain no prose — only column letters (A B C), numbers (230 268 416), and units (mm kW). FTS on natural-language questions ("What is the height of...") can't find them because the question words don't appear in the table content.

## The fix: two layers

### Write-time: spec-table tag (pdfExtractor.ts, Pass 5)
- At chunk write time, detect tabular chunks and append `[Specification table: technical data, dimensions, height, width, ...]`.
- Detection heuristic: a line is "tabular" if ≥60% of its tokens are spec-like (numeric, single uppercase letter A-Z, SI unit abbreviation). A chunk is a spec table if ≥35% of its non-empty lines are tabular and it has ≥3 lines.
- **Detector must be tight**: the old "≤4 chars alphanumeric" rule tagged 40% of chunks (prose warranty/safety text). Replaced with specific rules: pure numbers, numbers+unit suffix, `^\d+[x×/]\d+` (dimension strings), `^[A-Z]$` (dimension labels), explicit SI unit whitelist.

### Read-time: direct tag-based query (chat.ts, step 2d)
- FTS rank can still suppress the correct spec-table chunk when the machine's name contains generic words (e.g. "PACKAGING MACHINE" boosts packaging-section prose chunks, pushing the dimension table to rank 10+).
- After domain classification, run a SEPARATE direct query: `WHERE content LIKE '%[Specification table%'` limited to the classified manual(s).
- This guarantees spec tables are always in context regardless of FTS rank, as long as the domain is known.

## Why

**Why two layers?** FTS rank is unpredictable when query tokens coincide with the machine name (e.g. asking about a "VERTICAL VACUUM PACKAGING MACHINE" surfaces packaging-section chunks, not dimension tables). The write-time tag is the correct annotation; the direct tag query is the correct read path.

**Why not query-time synonym expansion?** Fragile — requires per-question synonym rules and doesn't generalize. Write-time enrichment + read-time tag retrieval is the principled solution.

## How to apply

- After any change to the spec-tag vocabulary or detection thresholds: restart server, rechunk all manuals (`POST /api/manuals/:id/rechunk` for each).
- Verify: `SELECT manual_id, COUNT(*) FROM chunks WHERE content LIKE '%[Specification table%' GROUP BY manual_id` — expect a SMALL count per manual (1-4 real spec tables, not 30+).
- The `TOP_K_SCOPED` constant (currently 14) sets how many chunks the domain-scoped FTS second-pass returns; the direct spec-table query is additive and independent.
