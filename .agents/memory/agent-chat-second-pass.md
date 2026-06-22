---
name: Agent chat second validation pass
description: How the 2-pass validation works in /api/chat/agent and why it exists
---

The agent endpoint runs up to two domain-specialist validation passes:
- Pass 1: specialist validates draftAnswer from GPT-4o
  - `pass` → use as-is
  - `revise` → specialist provides revisedAnswer; trigger Pass 2
  - `fail` → guided no-answer immediately
- Pass 2 (only if Pass 1 = "revise"): specialist validates the revisedAnswer
  - `pass` or `revise` → use revisedAnswer (revisedOnce=true, passCount=2)
  - `fail` → guided no-answer (revisedOnce=true, passCount=2)

Response always includes `validationMetadata: { validationPassCount, revisedOnce, finalValidationStatus }`.

**Why:** The original single-pass pipeline could deliver a "revise" answer that still contained unsupported claims. The second pass catches those without a full round-trip to the user.

**How to apply:** Any change to the revision flow in agentChat.ts (section "8. Determine final answer") must maintain this 2-pass structure. Do not skip the second pass when revisedAnswer exists.
