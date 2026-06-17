---
name: Replit AI embeddings not supported
description: The Replit AI integration proxy does not support the OpenAI /embeddings endpoint — use PostgreSQL FTS for RAG chunk retrieval instead.
---

The `openai.embeddings.create()` call returns a 400 error with code `INVALID_ENDPOINT` when routed through the Replit AI proxy (`AI_INTEGRATIONS_OPENAI_BASE_URL`).

**Why:** The proxy only passes through chat completions, not the embeddings endpoint.

**How to apply:** For any RAG/similarity search feature, use PostgreSQL full-text search (`to_tsvector` + `to_tsquery`) instead of vector similarity. Use the `fts_vector` generated column pattern:

```sql
-- On the table:
fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED

-- Query:
WHERE fts_vector @@ to_tsquery('english', $1)
ORDER BY ts_rank(fts_vector, to_tsquery('english', $1)) DESC
```

The `pgvector` extension can still be enabled for future use, but the embedding column should be nullable until a supported embedding source is available.
