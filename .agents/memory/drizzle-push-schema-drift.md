---
name: drizzle-kit push blocks on schema drift
description: drizzle-kit push fails non-interactively when DB has columns not in schema (e.g. embedding, fts_vector on chunks); use executeSql to create new tables directly
---

## Rule
Never use `pnpm --filter @workspace/db run push` in a non-TTY shell when the DB has drifted from the Drizzle schema. It will block with an interactive prompt about data-loss and then throw an error.

## Why
The chunks table has `embedding` (pgvector, nullable) and `fts_vector` (generated tsvector) columns in the DB that are not reflected in the current Drizzle schema files. drizzle-kit detects these as columns to drop and requires interactive confirmation. In non-TTY environments, this throws an error.

## How to apply
When creating a new table, use the `executeSql` callback in the `code_execution` tool to run `CREATE TABLE IF NOT EXISTS ...` directly. This bypasses drizzle-kit entirely and is safe as long as the new table doesn't conflict with existing ones.

```javascript
const result = await executeSql({
  sqlQuery: `CREATE TABLE IF NOT EXISTS my_new_table (...)`
});
```

This is the correct pattern for adding new tables to this project until the schema drift is resolved.
