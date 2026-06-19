---
name: Extraction status claim guard
description: Rule for the atomic "processing" claim guard on expensive extraction endpoints — every claimed job must reach a terminal status.
---

# Atomic claim guard on expensive extraction endpoints

Expensive, unauthenticated extraction routes (process / extract-graph / reprocess-vision)
claim a manual by atomically flipping `status -> 'processing'` only `WHERE status != 'processing'`
(a single conditional UPDATE returning affected rows). If it claimed nothing, the route rejects 409.
This is the primary cost-exhaustion guard (prevents duplicate parallel full-document LLM jobs);
`express-rate-limit` is only defense-in-depth.

**Why:** the guard rejects re-triggers while `status === 'processing'`. So any background job that
sets `processing` MUST guarantee a terminal status (`completed` / `structure_complete` / `failed`)
on EVERY exit path, including thrown errors. If a job throws without resetting status, the manual is
stuck in `processing` forever and the claim guard locks out all future re-triggers.

**How to apply:**
- Every long-running pipeline fn that sets `processing` needs a top-level try/catch that sets `failed`
  (with errorMessage) and rethrows. `runExtractionPipeline` and `extractGraphFromExistingText` both do.
- Route handlers that claim before any awaited pre-launch work (e.g. deleting prior entities) must, on
  failure of that work, reset status off `processing` — otherwise the claim leaks with no job running.
- There is no auth; per-IP rate limiting can be bypassed by rotating IPs. Treat real authorization as
  the only complete fix if the app goes multi-tenant / public.
