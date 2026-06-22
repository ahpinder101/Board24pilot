---
name: Scratchpad answer agent architecture
description: Two-pass LLM flow in agentChat.ts — scratchpad reasons about evidence and picks strategy before the answer pass runs.
---

## Pattern

**Pass 1 (scratchpad)**: GPT-4o reviews retrieved evidence + conversation history, outputs JSON with `{ questionType, domain, evidenceQuality, coveredAspects, uncoveredAspects, strategy, clarifyingQuestion, planNotes }`.

Strategies:
- `"answer"` → proceed to Pass 2 (heavily biased default)
- `"clarify"` → early return with a clarifying question (`isClarifying: true`, saved to DB, no specialist validation)
- `"cannot_answer"` → early return with `buildGuidedNoAnswer` (`isGuided: true`, saved to DB)

**Pass 2 (answer)**: System prompt includes scratchpad domain and planNotes. Conversation history prepended to messages array in chronological order.

**Why:** The old single-pass flow had a quote-gate ("NOT IN EXCERPTS → must say manual does not specify") that killed answers even when 34 relevant chunks were retrieved. The scratchpad decouples reasoning from generation.

## History loading — critical order detail

Query uses `ORDER BY created_at DESC LIMIT 6` then the result is reversed in code to restore chronological order before passing to prompts. Using `ASC LIMIT 12` fetches the oldest messages, not the most recent context.

**Why:** For follow-up questions ("what is the cause of this?"), the LLM needs the most recent 6 messages, not the oldest 12.

## Quote gate removal

The answer pass prompt previously forced "manual does not specify" whenever the quote field was NOT IN EXCERPTS. This gate is removed. The quote field is now described as "citation anchoring only" — it does not constrain the answer.

Rule 5 was added: "Multi-step procedures: synthesise from ALL excerpts — never say manual does not specify when steps are present."

## Confidence guard

`isGuided = true` always forces `confidence = "unverified"` in the response, preventing the "High confidence + Guided response" contradiction.
