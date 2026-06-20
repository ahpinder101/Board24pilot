---
name: RAG retrieval — phrase search beats OR ts_rank for precise facts
description: Why FTS OR-query ts_rank returns wrong answers/citations for specific-fact lookups, and the phrase + quote-grounding fix in chat.ts.
---

## The failure

A factual lookup ("Which circuit breaker protects the Folder Gluer Power supply, rated current?") returned the WRONG answer and WRONG citation, even though the correct fact sat plainly in one chunk. The user's framing was exact: "if you can find it by lookup, why can't the machine?"

## Root cause (verified, not guessed)

The chat route split the question into individual terms OR'd together (`term | term | …`) and ranked by `ts_rank`. `ts_rank` is term-frequency based, so a whole SECTION that repeats the question's common words ("folder"/"main"/"cabinet"/"control") outranks the ONE page where the precise multi-word fact appears once. The answer page was **not even in the OR top-40**. Everything downstream (citation, model context) was then working from the wrong pages.

**The diagnostic that proved it:** reproduce the exact OR query the route runs and print page numbers + rank. Then compare against a phrase/adjacency query for the specific term. The answer page that's absent from the OR top-40 comes back as #1 under phrase search.

## The fix (two independent layers)

1. **Phrase/adjacency retrieval** — `phraseto_tsquery('english', <phrase>)` (the `<->` operator). Build consecutive content-word n-grams (2–4 words, split at stopwords, longest first) from the question and run each. Phrase-matched chunks are PREPENDED to the context so the answer page is guaranteed present.
   - **Specificity gate for citations:** a phrase matching few chunks (`COUNT(*) OVER ()` ≤ ~8) is discriminating (e.g. "folder gluer power" → 1 page) and may drive citations; a phrase matching many (e.g. "main control cabinet" → 12, "power supply" → 49) is a common section term — keep it as context only. Generic verb phrases ("circuit breaker protects") can be rare-but-irrelevant, so phrase search alone cannot fully disambiguate the citation — hence layer 2.

2. **Quote-grounded citation** — the model already emits a verbatim `quote` field (chain-of-thought, see rag-chat-grounding.md). Match that normalized quote back to the chunk it came from (exact normalized-substring, then ≥70% token-coverage fallback). This pins the citation to the text the answer was actually built on and is the single most reliable citation signal. It runs as Priority 0, ahead of phrase / AND-query / model-self-reported sources.

**Why both:** layer 1 ensures the right chunk REACHES the model; layer 2 ensures the CITATION points at whatever the model actually used. Fixing only citation (an earlier attempt that re-ranked OR results by keyword coverage) failed because the answer page wasn't in the OR results at all.

## How to apply

For any "look up a specific value about a named thing" RAG question, do not rely on OR + ts_rank alone. Add phrase/adjacency retrieval for the named entity, and cite by matching the model's verbatim quote to a chunk — not by the model's self-reported source index, and not by single-word overlap.

## Verification pattern

The chat endpoint is Clerk-gated, so curl can't reach it. To test retrieval+synthesis end-to-end, run a standalone node script from the `scripts` package (so `pg` resolves), build the same prepended context, and POST to `${AI_INTEGRATIONS_OPENAI_BASE_URL}/chat/completions` with the gateway key via `fetch` (no openai SDK needed — the SDK is not resolvable from the workspace root).

## Known non-blocking weaknesses

- Phrase retrieval runs up to ~12 sequential `phraseto_tsquery` queries per request — fine now, watch latency at scale.
- The ≥0.7 quote token-coverage fallback can mis-pin among near-duplicate chunks; exact-substring is tried first. A rare/numeric-token-overlap guard would harden it.
