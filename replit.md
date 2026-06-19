# Engineering Manual Knowledge Graph

Upload PDF engineering manuals and let AI extract entities and relationships into an interactive, explorable knowledge graph.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, mounted at `/api`)
- `pnpm --filter @workspace/manual-graph run dev` — run the frontend (port 23578, mounted at `/`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + OpenAPI-first (Orval codegen)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- PDF parsing: `pdf-parse`
- AI: OpenAI (gpt-4o via Replit AI integration)
- Object storage: GCS via Replit object storage
- Frontend: React + Vite + Tailwind + shadcn/ui
- Graph: `@xyflow/react` + `@dagrejs/dagre` for auto-layout

## Where things live

- `lib/api-spec/openapi.yaml` — source of truth for API contract
- `lib/api-client-react/src/generated/` — auto-generated React Query hooks + Zod schemas (do not edit)
- `lib/db/src/schema/` — DB schema: `manuals.ts`, `entities.ts`, `chunks.ts`, `chat.ts`
- `artifacts/api-server/src/lib/extractionPipeline.ts` — 7-pass AI extraction pipeline (Pass 7 = text chunking)
- `artifacts/api-server/src/routes/` — manuals, graph, storage, chat route handlers
- `artifacts/manual-graph/src/` — React frontend (pages, components)
- `artifacts/manual-graph/src/pages/ask-page.tsx` — Ask Engineer chat UI

## Architecture decisions

- **Contract-first API**: OpenAPI spec drives both server validation (Zod) and client hooks (React Query). Any new endpoint needs the spec updated first, then `codegen` run.
- **7-pass pipeline**: document structure → page content → vision descriptions → entity extraction → relationship extraction → hierarchy ordering → text chunking (RAG). Each pass updates `processingPass` on the manual so the UI can show progress.
- **Async processing**: PDF processing runs in the background after upload; the frontend polls every 3s while `status === 'processing'`.
- **Object storage for PDFs**: Files go to GCS via presigned URL (client-side direct upload), then the API reads them from storage for processing.
- **Cross-manual graph**: entities and relationships are stored per-manual, but the global graph endpoint joins across all completed manuals.
- **RAG via FTS**: The Replit AI proxy does not support `/embeddings`, so RAG uses PostgreSQL full-text search (`to_tsvector` / `to_tsquery`) with a generated `fts_vector` column on the `chunks` table. Chat answers combine FTS chunk retrieval + graph entity/relationship keyword search, synthesized by GPT-4o.
- **pgvector is enabled** but `embedding` column is nullable — reserved for when a supported embedding source becomes available.

## Product

- Upload PDF engineering manuals (up to 50MB)
- AI extracts machines, components, subsystems, processes, parts, sensors, and their relationships via 7 AI passes (Pass 7 = text chunking for RAG)
- Interactive graph visualization with dagre auto-layout, node detail panel, minimap, and zoom
- Per-manual graph view with processing progress bar
- Global graph view combining all uploaded manuals
- Stats dashboard showing entity and relationship counts
- **Ask Engineer** (`/ask`): RAG chat — ask natural language questions, answers synthesized by GPT-4o from FTS chunk retrieval + graph entity/relationship search, with cited page references

## Auth

- **Replit-managed Clerk** (cookie-based on web). Provisioned via `setupClerkWhitelabelAuth()`; keys in `CLERK_*` / `VITE_CLERK_*` env vars (auto-managed, do not edit).
- Server: `clerkProxyMiddleware` (prod-only) mounted before body parsers, then `clerkMiddleware`; `requireAuth` (in `routes/index.ts`) gates **all** API routes except `/api/healthz`.
- Client: `App.tsx` wraps everything in `<ClerkProvider>`; signed-out users see `landing-page.tsx`, sign-in/up at `/sign-in` and `/sign-up`.
- **Invite-only allowlist:** `requireAuth` enforces an `ALLOWED_EMAILS` env var (comma/space separated; full emails or `@domain` entries). Unset = disabled (any signed-in user; logs a startup warning). Set = non-listed emails get 403. Requires an api-server restart to pick up changes. See `.agents/memory/clerk-invite-only.md`.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Run `pnpm run typecheck:libs` after changing any `lib/*` package before typechecking artifacts — stale declarations cause false positives.
- `@workspace/api-client-react` re-exports everything from `src/generated/api` and `src/generated/api.schemas` — import from the package root only, never from `/src/generated/...` directly (Vite will reject deep imports into workspace packages).
- Orval-generated hooks require `queryKey` in the `query` options object when passing custom options — use `getGet<Name>QueryKey(id)` from the same package.
- `lib/object-storage-web` needs `composite: true` in its tsconfig to be used as a TypeScript project reference from artifacts.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
