---
name: Never restart API server during extraction
description: Restarting the API server kills any background extraction job mid-run, losing all in-memory work that hasn't been saved to DB yet.
---

## Rule
Never call `restart_workflow` on the API server while an extraction job is running (status=processing, processingPass=4/5/6).

**Why:** The extraction job runs as a background async task inside the server process. Killing the server kills the task. Any pass that bulk-inserts at the end (previously pass 5 relationships, pass 5b paths) loses ALL work done up to that point.

**How to apply:**
- Before restarting the API server, always check `SELECT status FROM manuals WHERE status = 'processing'`
- If any manual is processing, wait for it to finish or fail before restarting
- Pass 5 now saves per-chunk (fixed), so this is less catastrophic, but still causes a full pass 5 re-run
- Pass 5b (paths) still bulk-inserts — same risk remains for that sub-pass
