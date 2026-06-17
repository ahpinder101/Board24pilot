---
name: Drizzle sql ANY array
description: Passing a JS array directly into a drizzle sql`` template for ANY() generates broken SQL — use a PostgreSQL array literal string instead.
---

When writing raw SQL with Drizzle's `sql` tagged template and using `ANY()` with a JavaScript array, Drizzle interpolates the array as multiple positional parameters `($1, $2, ...)` rather than a PostgreSQL array — causing the error: `op ANY/ALL (array) requires array on right side`.

**Wrong:**
```typescript
const ids = [1, 2, 3];
sql`WHERE id = ANY(${ids})`
// Generates: WHERE id = ANY(($1, $2, $3))  ← broken
```

**Correct:**
```typescript
const ids = [1, 2, 3];
const pgArrayLiteral = `{${ids.join(",")}}`;
sql`WHERE id = ANY(${pgArrayLiteral}::integer[])`
// Generates: WHERE id = ANY('{1,2,3}'::integer[])  ← correct
```

**Why:** Drizzle's `sql` template treats arrays as lists of parameters, not PostgreSQL array literals.
