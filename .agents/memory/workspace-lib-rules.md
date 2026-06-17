---
name: Workspace lib rules
description: Key pitfalls with TypeScript composite libs, workspace deep imports, and Orval-generated hooks in this monorepo
---

## Rules

1. **Always run `pnpm run typecheck:libs` after changing any `lib/*` package** before typechecking artifacts. Stale `.d.ts` declarations cause false "module has no exported member" errors that disappear after rebuild.

2. **Never deep-import workspace packages** (e.g. `@workspace/api-client-react/src/generated/api`). Vite rejects deep imports into workspace packages without explicit `exports` in `package.json`. Always import from the package root.

3. **Orval-generated hooks require explicit `queryKey`** when passing custom `query` options. Use `getGet<Name>QueryKey(id)` from the same package.

4. **`lib/object-storage-web` needs `composite: true`** in its tsconfig to be referenced from artifact tsconfigs. Without it, TypeScript throws "Referenced project must have setting composite: true".

**Why:** These patterns caught us during the manual-graph build and required multiple fix rounds. Future builds should apply them proactively.

**How to apply:** Before finishing any new feature that touches libs or uses Orval hooks, run `typecheck:libs` and verify import paths use package roots.
