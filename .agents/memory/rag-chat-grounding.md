---
name: RAG chat grounding
description: How hallucination was diagnosed and fixed in the chat route; what remains as OCR-level errors vs model errors.
---

## What was implemented

In `artifacts/api-server/src/routes/chat.ts`:

1. **Verbatim values rule (rule 8)** added to the system prompt — any specific value (number, measurement, product name, code) must be copied character-for-character from the excerpts. If it doesn't appear literally, say "The manual does not specify this."

2. **Chain-of-thought `quote` field** added to the JSON output format. The model must copy the verbatim excerpt sentence into `quote` before writing `answer`. If no sentence exists, `quote = "NOT IN EXCERPTS"` and `answer` must say "The manual does not specify this." The `quote` field is discarded in parsing (logged at debug level) — it exists only to mechanically prevent fabrication.

3. **Temperature set to 0** — extraction task, not composition.

## Why it works

The root cause of hallucination in RAG is that a generative model is being asked to *compose* an answer from context. During composition, parametric memory (training data) leaks in alongside retrieved context. Chain-of-thought forces the model to locate and quote a source sentence first, making it structurally impossible to fabricate a value without also fabricating the quote — a contradiction that the model avoids.

## What this fixed

Validated on 20-question audit of the Dualit Jug Kettle manual:
- Q13 (brown spots): was "not found", now correctly answered — CoT found the relevant excerpt.
- Q16 (hot lid): now correctly returns "The manual does not specify this."
- Q19 (400mm distance): confirmed NOT a hallucination — "400mm" literally appears in the manual chunk. Earlier audit was wrong to flag it.

Final score: 18/20. Two remaining errors are OCR corruption, not model behaviour.

## What the quote field exposed as OCR errors (not model errors)

- **Q9 "Kilrock L"**: chunk text reads "Kilrock L" — PDF OCR misread the letter K as L. Model is quoting faithfully from a corrupt source.
- **Q11 "1.5 inches"**: chunk text reads `1.5"` — PDF parser converted the degree symbol `°` into an inch symbol `"` and split `15°` into `1.5"`. Model is quoting faithfully from a corrupt source.

These cannot be fixed by prompting. They require post-processing of chunk text at extraction time (° symbol normalisation).

**Why:** the `quote` field is the diagnostic. If `quote` and `answer` agree and both are wrong, the source chunk is corrupt. If `quote` is "NOT IN EXCERPTS" but `answer` states a fact, the model is hallucinating.
