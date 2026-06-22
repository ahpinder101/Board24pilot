---
name: Scratchpad answer agent architecture
description: Two-pass LLM flow in agentChat.ts — scratchpad reasons about evidence and picks strategy before the answer pass runs.
---

## Pattern

**Pass 1 (scratchpad)**: GPT-4o reviews ragContext + graphContext + conversation history, outputs JSON:
`{ questionType, domain, evidenceQuality, coveredAspects, uncoveredAspects, strategy, clarifyingQuestion, planNotes }`

Strategies:
- `"answer"` → proceed to Pass 2 (default, heavily biased toward this)
- `"clarify"` → early return with clarifying question (isClarifying: true in response, saved to DB)
- `"cannot_answer"` → early return with buildGuidedNoAnswer (isGuided: true, saved to DB)

**Pass 2 (answer)**: Uses scratchpad.domain (not detectDomain), scratchpad.planNotes injected into system prompt, conversation history prepended to messages array (last 6, 1200 char limit).

## Key quote gate removal

Old prompt had: "If quote is NOT IN EXCERPTS, answer must say the manual does not specify this."
This was the primary cause of false "not in excerpts" answers even with 34 relevant chunks.

New quote field: "citation anchoring only, does NOT constrain your answer."
Added Rule 5: "Multi-step procedures: synthesise from ALL excerpts — never say manual does not specify when steps are present."

## Confidence guard

`finalConfidence = isGuided ? "unverified" : finalSpecialistResult.confidence`

This was added to prevent the "High confidence + Guided response" contradiction visible in the old UI.

## Conversation history

Loaded in the initial `Promise.all` alongside manuals and machine entities.
Uses `sessionId` (not `incomingSession`) — new sessions return 0 rows automatically.
Scratchpad receives last 400 chars per message; answer pass receives last 6 messages at 1200 chars each.

**Why:** `sessionId` is always defined (either from client or from `randomUUID()`). Loading history for a brand-new UUID simply returns empty rows — no conditional branch needed.
