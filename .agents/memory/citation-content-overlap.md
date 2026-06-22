---
name: Citation content-overlap fallback
description: Phrase match citation is validated against answer-word overlap (12% threshold); a new P2 content-overlap priority finds the best chunk when all other signals fail.
---

## Rule
Citation priority order in chat.ts and agentChat.ts:
- P0: Quote-grounded (verbatim match ≥ 70% token match)
- P1: Phrase match **validated** — reject if chunk has < 12% answer-token overlap (PHRASE_OVERLAP_MIN)
- P2: Content-overlap — find ragChunk with highest answer-word overlap (≥ 6% floor)
- P3: AND query
- P4: Model-reported sources (unreliable)
- P5: Top chunk fallback

## Why
FTS stemming produces false-positive phrase citations: "oil supply" → "oil suppli" matched p.50 (rotary hook lubrication table) instead of p.37 (oil replenishment procedure). The model's `sources` field is also unreliable when the answer is synthesised from general knowledge + partial evidence. Content-overlap between the final answer and ragChunks is a more faithful signal: the chunk that shares the most vocabulary with the actual answer is almost certainly where the model drew the information.

## How to apply
- `answerTokens` = lowercased answer, split on \W+, filter length > 3 and not in OVERLAP_STOPWORDS set.
- `computeOverlap(chunk.content)` = hits.length / answerTokens.size.
- PHRASE_OVERLAP_MIN = 0.12 (reject phrase chunks below this — prevents false positives).
- CONTENT_OVERLAP_MIN = 0.06 (minimum for P2 to fire — avoid citing chunks with only 1-2 coincidental word matches).
- Only activates when answerTokens.size > 5 (avoid firing on very short answers).
- Applied identically in both chat.ts and agentChat.ts.
