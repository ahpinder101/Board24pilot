# Replit Prompt: Evidence-Driven Manual Q&A Upgrade

You are working in an existing Replit app.

The app already contains pre-ingested technical manual data in Postgres / pgvector or an equivalent searchable backend. It may already have:

- a simple query interface;
- a graphical relationship view;
- existing backend query functions;
- existing document/chunk services;
- graph data or graph visualisation;
- existing UI components that can be reused.

Do **not** assume the exact database schema.

Do **not** assume the UI framework.

Do **not** assume the backend architecture.

Do **not** destroy or replace existing data.

Do **not** rewrite ingestion unless absolutely necessary.

Your task is to upgrade the app into an evidence-driven technical manual Q&A system while preserving the existing application and reusing useful existing components.

---

## Goal

Upgrade the app so users can ask technical questions about manuals, diagrams and procedures, and receive answers that are:

- grounded in source evidence;
- traceable to documents, pages, chunks, diagrams or JSON objects;
- validated for technical completeness where possible;
- clear for business users;
- cautious and helpful when evidence is missing;
- able to use structured JSON such as entities, relationships, paths, behaviours, validation checks and citations.

The system should support complex technical knowledge such as:

- electrical wiring diagrams;
- control circuits;
- hydraulic schematics;
- pneumatic schematics;
- troubleshooting flowcharts;
- assembly instructions;
- process instructions;
- complex diagram-understanding JSON.

---

## Non-destructive implementation rules

Before making changes:

1. Inspect the existing codebase and database schema.
2. Identify the app’s actual frontend technology and backend structure.
3. Identify existing reusable services, query functions, UI components and graph components.
4. Reuse or wrap existing components where practical.
5. Keep the current simple query interface working.
6. Do not drop, truncate, overwrite, recreate or re-ingest existing data unless explicitly required.
7. Use additive migrations only:
   - new tables;
   - new views;
   - new adapters;
   - new service functions;
   - optional UI panels;
   - feature flags;
   - compatibility wrappers.
8. Add the new agentic workflow beside the existing flow first.
9. Only route the main UI through the new flow once it is tested.
10. If a change is risky, add it behind an admin/developer toggle.

---

## Technology adaptation rule

Use the app’s existing technology stack wherever possible.

Do not introduce a new frontend framework unless the existing app has no usable UI layer.

Do not introduce a new backend framework unless the existing backend cannot support the required services.

If the app already has React, use React.

If the app already has Streamlit, use Streamlit.

If the app already has Flask/FastAPI/Express/Next.js or another backend, extend that structure.

If there is an existing graph visualisation component, reuse it.

If there is an existing document selector, source display, loading state or chat component, reuse it.

Prefer wrappers and adapters over rewrites.

---

## High-level architecture

Implement three narrow agents/services:

1. **Retrieval Agent**
   - Finds and packages structured evidence.
   - Does not write final prose answers.

2. **Domain Specialist Agent**
   - Validates whether a draft answer is complete, grounded and technically safe.
   - Does not retrieve raw data.
   - Does not answer the user directly.

3. **Query Handling Agent**
   - User-facing orchestrator.
   - Calls retrieval.
   - Drafts the answer from retrieved evidence only.
   - Calls validation.
   - Revises once if needed.
   - Returns final answer, cautious answer, or guided next step.

Core flow:

User question
→ Query Handling Agent
→ Retrieval Agent
→ structured evidence package
→ draft answer
→ Domain Specialist validation
→ final answer, cautious answer, or guided no-answer

---

# Stage 0 — Schema discovery and compatibility adapter

Do not assume table names, column names or JSON structure.

Create or adapt a service/function:

```text
inspect_existing_manual_schema()
```

It should discover:

- existing tables and columns;
- JSONB or JSON fields;
- vector fields;
- document/page/chunk identifiers;
- source/citation fields;
- confidence/trust fields;
- relationship/graph tables;
- existing backend query functions;
- existing graph and UI components;
- reuse opportunities;
- missing capabilities.

Return:

```json
{
  "tables": [],
  "document_tables": [],
  "page_tables": [],
  "chunk_or_embedding_tables": [],
  "json_columns": [],
  "vector_columns": [],
  "relationship_tables": [],
  "candidate_entity_fields": [],
  "candidate_relationship_fields": [],
  "candidate_path_fields": [],
  "candidate_behavior_fields": [],
  "candidate_validation_fields": [],
  "candidate_citation_fields": [],
  "existing_query_functions": [],
  "existing_graph_views": [],
  "existing_ui_components": [],
  "schema_confidence": 0,
  "reuse_opportunities": [],
  "missing_capabilities": [],
  "notes": []
}
```

Create:

```text
manual_evidence_adapter
```

This adapter normalizes whatever schema exists into canonical evidence units.

All new agents must use this adapter rather than querying raw tables directly.

Canonical evidence unit:

```json
{
  "evidence_id": "string",
  "source_document_id": "string|null",
  "source_name": "string|null",
  "page_number": "number|null",
  "chunk_id": "string|null",
  "diagram_id": "string|null",
  "region_id": "string|null",
  "object_type": "document|page|chunk|text_claim|entity|relationship|path|behavior|validation_check|source_region|unknown",
  "object_subtype": "string|null",
  "title": "string|null",
  "text": "string",
  "labels": [],
  "payload": {},
  "confidence": "number|null",
  "trust_status": "string|null",
  "safe_answering_mode": "string|null",
  "citation_quality": "strong|partial|weak|missing",
  "source_ref": {},
  "embedding_ref": "object|null",
  "graph_refs": {
    "node_ids": [],
    "edge_ids": [],
    "path_ids": []
  }
}
```

Adapter behaviour:

- If normalized entity, relationship, path or behaviour tables exist, map them directly.
- If these structures exist only inside JSON/JSONB, extract them dynamically.
- If only chunks and embeddings exist, return chunk evidence and mark answerability weaker.
- If graph tables exist, use them for graph expansion.
- If no graph table exists but JSON has relationship/path arrays, construct graph context in memory.
- If citations are missing, create best-effort source references and mark citation quality as weak.
- If confidence/trust fields are missing, set them to null and answer cautiously.

Add a developer/admin diagnostic view or endpoint, using the existing UI/backend conventions:

```text
schema discovery diagnostics
```

This should show:

- discovered tables;
- vector columns;
- JSON columns;
- mapped evidence fields;
- existing components reused;
- missing expected capabilities;
- adapter confidence;
- weak citation warnings;
- fallback behaviour currently active.

Hide schema diagnostics from normal business users.

---

# Stage 1 — Flexible Retrieval Agent

Create or adapt:

```text
retrieve_structured_evidence(input) -> output
```

Input:

```json
{
  "question": "string",
  "domain_hint": "string|null",
  "retrieval_mode": "auto|fact_lookup|process_trace|relationship_trace|troubleshooting_flow|part_identification|cause_effect|comparison|safety_or_validation",
  "filters": {
    "document_ids": "string[]|null",
    "page_numbers": "number[]|null",
    "diagram_types": "string[]|null",
    "min_confidence": "number|null",
    "trust_status": "string[]|null",
    "safe_answering_mode": "string[]|null"
  },
  "max_results": "number|null"
}
```

Output:

```json
{
  "query_interpretation": {
    "original_question": "string",
    "intent": "string",
    "domain": "string|null",
    "entities_mentioned": [],
    "actions_or_events_mentioned": [],
    "expected_answer_shape": "string"
  },
  "schema_mapping": {
    "schema_confidence": 0,
    "evidence_sources_used": [],
    "limitations": []
  },
  "answerability": {
    "status": "answerable|partially_answerable|not_answerable",
    "confidence": 0,
    "safe_answering_mode": "detailed|cautious|guided_no_answer",
    "reason": "string"
  },
  "evidence": {
    "documents": [],
    "pages": [],
    "chunks": [],
    "text_claims": [],
    "entities": [],
    "relationships": [],
    "paths": [],
    "behaviors": [],
    "validation_checks": [],
    "source_regions": []
  },
  "graph_context": {
    "available": false,
    "source": "relationship_table|json_arrays|inferred_from_paths|not_available",
    "seed_nodes": [],
    "expanded_nodes": [],
    "expanded_edges": [],
    "matched_paths": []
  },
  "missing_or_weak_evidence": [],
  "citations": [],
  "suggested_next_steps": []
}
```

Retrieval behaviour:

1. Interpret the user question.
2. Use the adapter to identify available evidence types.
3. Run semantic search if vector columns exist.
4. Run keyword search over available text fields.
5. Search JSON structures for:
   - entities;
   - relationships;
   - paths;
   - behaviours;
   - validation checks;
   - source references.
6. Use graph expansion if graph data exists.
7. If graph data is unavailable, approximate graph context from JSON path sequences and relationships.
8. For process questions, prefer:
   - paths;
   - behaviours;
   - relationships;
   - validation checks;
   - source claims;
   over plain chunks.
9. Return structured evidence only.

Answerability rules:

- Strong structured evidence + citations → `answerable`.
- Partial structure or weak citations → `partially_answerable`.
- Only chunks available → cautious answer unless the chunk directly answers the question.
- No relevant evidence → `not_answerable` with suggested next steps.
- Never allow unsupported technical claims.

---

# Stage 2 — Complex JSON and technical diagram reasoning

The system must support complex technical knowledge stored in JSON, including:

- electrical wiring diagrams;
- hydraulic schematics;
- pneumatic schematics;
- troubleshooting flows;
- assembly instructions;
- multi-step technical procedures.

When structured JSON is available, prioritise evidence in this order:

1. Validated paths or sequences.
2. Explicit relationships.
3. Behaviour or state-change records.
4. Source text claims.
5. Diagram regions and captions.
6. Plain chunks as fallback only.

For electrical wiring diagrams, the system must distinguish between:

- control circuit paths;
- power circuit paths;
- return paths;
- normally open and normally closed states;
- coils;
- contacts;
- relays;
- actuators;
- holding or seal-in circuits;
- interlocks;
- protection devices;
- loads;
- stop or de-energise conditions.

For wiring/process answers, the Retrieval Agent should attempt to reconstruct the full evidence chain:

source/input
→ control or switching element
→ actuator/coil/state change
→ controlled contact/output
→ load/result
→ return path
→ stop/reset/failure condition if relevant

The Domain Specialist must reject or revise answers that:

- skip an important step in the circuit or process;
- mix up control power and load power;
- claim a component energises without a complete path;
- claim a relationship that is not present in the evidence;
- infer a holding path, interlock or safety function without structured evidence;
- cite a chunk that does not actually support the claim.

If only partial JSON structure is available, say which part is confirmed and which part is not.

If only text chunks are available, provide a chunk-grounded explanation only. Do not claim graph-level certainty.

Scratchpads may help remember where useful evidence was previously found, but they must never replace fresh retrieval from source evidence.

---

# Stage 3 — Domain inventory and Domain Specialist

Create or adapt:

```text
scan_domain_coverage(input) -> output
```

Input:

```json
{ "domain_id": "string|null" }
```

It should inspect available evidence through the adapter and map documents to likely domains.

Starter domains:

- generic_process
- electrical_control
- hydraulic_schematic
- pneumatic_schematic
- mechanical_assembly
- troubleshooting_flowchart
- network_diagram

Each profile should include:

```json
{
  "domain_id": "string",
  "domain_name": "string",
  "business_label": "string",
  "description": "string",
  "detection_rules": {
    "diagram_types": [],
    "keywords": [],
    "entity_types": [],
    "path_types": [],
    "relationship_types": []
  },
  "process_validation_rules": {
    "required_process_stages": [],
    "preferred_evidence_types": [],
    "minimum_evidence_types_for_detailed_answer": []
  },
  "critical_missing_items": [],
  "unsafe_claim_patterns": [],
  "confidence_thresholds": {
    "detailed": 0.85,
    "cautious": 0.6,
    "guided_no_answer": 0.4
  }
}
```

Create or adapt:

```text
validate_domain_answer(input) -> output
```

Input:

```json
{
  "question": "string",
  "draft_answer": "string",
  "evidence_package": {},
  "domain": "string|null",
  "strictness": "normal|engineering_strict|safety_critical"
}
```

Output:

```json
{
  "validation_status": "pass|revise|fail",
  "user_facing_status": "ready|needs_caution|needs_more_information",
  "domain": "string",
  "detected_question_type": "string",
  "coverage": {
    "required_items": [],
    "present_items": [],
    "missing_items": [],
    "weak_items": []
  },
  "unsupported_claims": [],
  "citation_issues": [],
  "sequence_issues": [],
  "schema_limitations": [],
  "safety_or_confidence_issues": [],
  "revision_instructions": [],
  "suggested_user_guidance": [],
  "final_confidence": 0
}
```

For process questions, validate end-to-end coverage.

Generic process stages:

- initial condition;
- trigger event;
- source/input;
- control or decision point;
- ordered sequence;
- state change;
- result/output;
- feedback or maintained state if relevant;
- stop/reset/failure condition if relevant;
- source evidence.

Electrical control stages:

- supply source;
- return path;
- normal state of controls;
- trigger action;
- control path;
- coil or actuator response;
- controlled contacts or outputs;
- load power path;
- protection device if present;
- holding or interlock path if relevant;
- stop or de-energise condition if relevant;
- source evidence.

Hydraulic stages:

- fluid source;
- pressure or flow condition;
- control valve state;
- flow path;
- actuator response;
- return path;
- pressure protection;
- failure or relief condition if relevant;
- source evidence.

Mechanical assembly stages:

- starting assembly state;
- parts involved;
- fasteners or retainers;
- removal or installation order;
- orientation or alignment constraints;
- sealing, torque or fitment constraints if available;
- final state;
- source evidence.

Troubleshooting stages:

- symptom;
- first check;
- decision branch;
- condition;
- action;
- next check or resolution;
- safety warning if present;
- source evidence.

If evidence is incomplete, do not fail abruptly. Return:

- what was found;
- what is missing;
- whether a cautious answer is possible;
- what the user can try next.

---

# Stage 4 — Efficient scratchpads and memory hygiene

Scratchpads are working memory, not source truth.

They should help agents work efficiently without becoming stale, large or misleading.

Source evidence always wins.

Use two scratchpad types:

## 1. Run scratchpad

- Temporary for one query.
- Can be detailed.
- Used during retrieval, validation and drafting.
- Retain for debugging for 24 hours.
- Then delete or archive.

## 2. Retained summary

- Short reusable summary retained across related questions.
- Max 500 tokens per summary.
- Max 10 summaries per conversation.
- Max 20 summaries per document/domain pair.
- Stale after 30 days.
- Stale immediately after document re-ingestion or schema mapping change.
- Never cited as evidence.

Create or reuse persistence. If needed:

```sql
agent_scratchpads (
  id uuid primary key,
  conversation_id text,
  agent_name text,
  scratchpad_type text,
  question text,
  domain text null,
  document_ids text[] null,
  evidence_ids text[] null,
  tags text[] null,
  scratchpad jsonb,
  token_estimate integer,
  usefulness_score numeric,
  stale_after timestamp null,
  created_at timestamp,
  updated_at timestamp,
  compressed_from_ids uuid[] null
)
```

Lifecycle:

1. Create run scratchpad for each query.
2. Use it only during the current query.
3. At query end, decide if it contains reusable information.
4. If not useful, delete or expire it.
5. If useful, compress into retained summary.
6. Do not inject all retained summaries into future queries.
7. Recall only top 3 relevant summaries by:
   - document;
   - domain;
   - entities;
   - diagram type;
   - semantic similarity;
   - usefulness score.
8. Re-retrieve fresh source evidence before answering.

Hard token budgets:

- Retrieval Agent run scratchpad: max 3,000 tokens.
- Domain Specialist run scratchpad: max 2,000 tokens.
- Query Handling Agent run scratchpad: max 2,000 tokens.
- Retained summary per agent: max 500 tokens.
- Total retained context injected into a new query: max 1,500 tokens.

Compression should keep only:

```json
{
  "summary": "short reusable context",
  "domain": "string|null",
  "documents_in_scope": [],
  "useful_entities": [],
  "useful_paths_or_relationships": [],
  "validated_findings": [],
  "known_limitations": [],
  "failed_search_patterns": [],
  "recommended_follow_up_queries": [],
  "evidence_ids": [],
  "citation_ids": [],
  "freshness": {
    "created_at": "timestamp",
    "last_used_at": "timestamp",
    "stale_after": "timestamp",
    "document_version_ids": []
  }
}
```

Do not retain:

- full reasoning traces;
- duplicate chunks;
- full evidence packages;
- unsupported assumptions;
- old draft answers;
- irrelevant user text;
- anything not linked to a document, domain, evidence item or reusable workflow.

Scratchpad safety rules:

- Scratchpads never override source evidence.
- Scratchpads are never cited as sources.
- Scratchpads can suggest where to look, but retrieval must re-check manual data.
- If scratchpad context conflicts with fresh evidence, fresh evidence wins.
- Hide scratchpads from business users by default.

Business-user controls should be simple and optional:

- Use recent context.
- Start fresh.
- Clear recent context.

Developer/admin controls:

- view scratchpads;
- view compression status;
- token estimate;
- stale summaries;
- usefulness scores;
- linked evidence IDs.

---

# Stage 5 — Query Handling Agent

Create or adapt:

```text
handle_user_query(input) -> output
```

Input:

```json
{
  "conversation_id": "string",
  "question": "string",
  "selected_domain": "string|null",
  "retrieval_mode": "string|null",
  "strictness": "normal|engineering_strict|safety_critical",
  "document_filters": {
    "document_ids": "string[]|null",
    "page_numbers": "number[]|null",
    "diagram_types": "string[]|null"
  },
  "context_options": {
    "use_recent_context": true,
    "start_fresh": false
  },
  "ui_options": {
    "show_evidence": false,
    "show_validation": false,
    "show_graph_context": false,
    "show_scratchpads": false,
    "show_schema_diagnostics": false
  }
}
```

Output:

```json
{
  "final_answer": "string",
  "answerability": {},
  "citations": [],
  "evidence_summary": {},
  "validation_summary": {},
  "graph_context": "object|null",
  "schema_diagnostics": "object|null",
  "suggested_next_steps": [],
  "debug": {
    "retrieval_scratchpad_id": "string|null",
    "specialist_scratchpad_id": "string|null",
    "query_handler_scratchpad_id": "string|null"
  }
}
```

Behaviour:

1. Receive question.
2. Recall only relevant retained summaries if “Use recent context” is enabled.
3. Detect or accept domain and retrieval mode.
4. Call Retrieval Agent.
5. Draft answer using only retrieved evidence.
6. Call Domain Specialist.
7. If validation passes, return final answer.
8. If validation says revise, revise once and revalidate.
9. If validation fails, return cautious answer or guided no-answer.
10. Compress or clear run scratchpads at the end.
11. Never invent technical claims.

Final answer modes:

## Confident answer

Use when evidence is strong and validation passed.

Include:

- direct answer;
- sources;
- confidence.

## Cautious answer

Use when partial evidence exists.

Include:

- what is known;
- what is uncertain;
- what evidence is missing.

## Guided no-answer

Use when no reliable evidence is available or validation fails.

Template:

```text
I could not confirm this from the available manual data.

What I checked:
- [documents/pages/evidence types checked]

What I found:
- [brief relevant findings, if any]

What is missing:
- [missing path, relationship, source, validation check, page, diagram or citation]

You could try:
- selecting a specific manual or page;
- using the exact component name, symptom or diagram label;
- asking about one step in the process;
- checking whether the manual page has been ingested with diagram relationships.
```

Never return abrupt messages like:

- “No answer found.”
- “Validation failed.”
- “Insufficient data.”

---

# Stage 6 — Business-friendly UI, technology-agnostic

Use the app’s existing UI technology and design conventions.

Do not force a specific UI framework.

Do not rebuild the UI unless necessary.

Reuse existing UI components where practical.

Normal user UI should avoid technical labels like:

- pgvector;
- JSONB;
- embeddings;
- raw schema diagnostics;
- graph expansion;
- scratchpads.

Recommended business-user inputs, adapted to the existing UI framework:

1. Question input
   - Label: “What do you want to know?”
   - Placeholder: “Ask about a process, component, symptom, diagram or procedure…”

2. Manual/document selector
   - “All manuals”
   - existing manual names

3. Question type
   - Let the system decide
   - Explain a process
   - Find a component or part
   - Explain a relationship
   - Troubleshoot a symptom
   - Compare items
   - Check safety or validation

4. Technical area
   - Let the system decide
   - General process
   - Electrical controls
   - Hydraulics
   - Pneumatics
   - Mechanical assembly
   - Troubleshooting
   - Network diagrams

5. Answer style
   - Balanced
   - Strict / only answer when well supported
   - Safety-critical

6. Context options
   - Use recent context
   - Start fresh
   - Clear recent context

7. Display option
   - Answer only
   - Answer with sources
   - Answer with evidence summary
   - Answer with validation summary

Result panel should show:

- final answer;
- confidence indicator:
  - High confidence;
  - Medium confidence;
  - Low confidence;
  - Could not verify;
- sources used;
- evidence summary;
- validation summary;
- missing information;
- suggested next steps.

Advanced/admin area should be collapsed or hidden by default.

Advanced/admin controls:

- retrieval mode;
- minimum confidence;
- page filters;
- diagram filters;
- trust status;
- show graph context;
- show schema diagnostics;
- show scratchpads;
- pin evidence;
- exclude evidence;
- mark evidence relevant/not relevant;
- override detected domain.

Developer/admin diagnostics should include:

- schema discovery diagnostics;
- scratchpad diagnostics;
- adapter mapping;
- graph fallback mode;
- citation quality;
- stale context status.

---

# Stage 7 — Reuse existing backend and UI

Before adding new code, identify reusable parts.

Backend reuse opportunities:

- DB client;
- embedding search;
- query endpoints;
- document/chunk services;
- graph APIs;
- auth/session handling;
- logging;
- conversation/message store.

UI reuse opportunities:

- search box;
- chat interface;
- document selector;
- graph view;
- source/citation display;
- loading/error components;
- tabs, accordions and panels.

If an existing component is usable, wrap or extend it instead of duplicating it.

Suggested modular components or functions, adapted to the app’s existing framework:

- query panel;
- evidence summary;
- validation summary;
- source list;
- graph context;
- guided no-answer;
- context controls;
- advanced evidence settings;
- schema diagnostics;
- scratchpad diagnostics.

---

# Stage 8 — Testing and acceptance criteria

Add tests or manual test scripts for:

1. Existing simple query still works.
2. Existing UI still works.
3. Schema discovery completes without destructive changes.
4. Adapter maps available data into evidence units.
5. Retrieval Agent returns structured evidence.
6. Retrieval works when graph/relationship data exists.
7. Retrieval degrades gracefully when only chunks exist.
8. Complex JSON paths/relationships/behaviours are retrieved where present.
9. Electrical wiring questions distinguish control path, power path and return path.
10. Domain inventory detects likely document domains.
11. Domain Specialist validates a complete process answer.
12. Domain Specialist flags missing process steps.
13. Query Handling Agent returns confident answers when evidence is strong.
14. Query Handling Agent returns cautious answers when evidence is partial.
15. Query Handling Agent returns guided no-answer when evidence is missing.
16. Scratchpads are compressed or cleared after use.
17. Stale scratchpads are not injected into new queries.
18. Business UI hides technical complexity by default.
19. Advanced/admin UI exposes diagnostics.
20. Final answers include sources or explain weak citation quality.
21. No unsupported engineering details are invented.
22. No existing app functionality is broken.
23. No existing data is destroyed.
24. No unnecessary new UI framework is introduced.

Degradation policy:

- Full structured schema → detailed evidence-grounded answers.
- Partial structure → cautious answer with missing evidence warning.
- Only chunks → chunk-grounded answer only; no unsupported process certainty.
- No relevant evidence → guided no-answer with next steps.
- Validation fails → remove unsupported claims; answer cautiously if possible; otherwise guide the user.

Prioritise:

1. preserving the existing app;
2. reusing existing components;
3. adapting to the existing UI/backend stack;
4. traceability;
5. graceful user experience;
6. technical correctness;
7. complex JSON and diagram reasoning;
8. efficient scratchpad memory;
9. business-friendly UI;
10. advanced diagnostics only where useful.
