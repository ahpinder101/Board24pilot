---
name: tsc --build timeout
description: tsc --build for composite libs often times out in this Replit environment; manually updating dist/*.d.ts files is the fastest unblock.
---

Running `tsc --build` or `tsc --project lib/<pkg>/tsconfig.json` frequently times out in this environment (even with 90s+ limits), making the standard `pnpm run typecheck:libs` approach unreliable for rapid iteration.

**Why:** The environment has limited CPU/memory for TypeScript compilation of large monorepos.

**How to apply:**
1. After changing a `lib/*` package's source files, check whether the corresponding `dist/*.d.ts` file needs updating.
2. Manually edit the `.d.ts` file in `lib/<pkg>/dist/` to match the new types — this is safe because the API server is built with esbuild (not tsc), so only the type declarations matter for consuming artifacts.
3. When the lib change is simple (add/remove a column, add/remove an export), a hand-edited `.d.ts` is faster and more reliable than waiting for tsc.
4. Run `pnpm --filter @workspace/<artifact> run typecheck` (with 60s) to verify the artifact side is clean.
