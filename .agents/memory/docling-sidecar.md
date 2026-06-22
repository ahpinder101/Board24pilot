---
name: Docling FastAPI sidecar
description: Architecture decisions and gotchas for the Docling PDF extraction sidecar service.
---

## Service location
- `artifacts/docling-service/main.py` — FastAPI app, port 8000
- Workflow: `artifacts/docling-service: Docling PDF Service` (created via configureWorkflow, persisted)
- Node.js client: `extractWithDocling()` in `artifacts/api-server/src/lib/pdfExtractor.ts`

## Critical: background model loading
DocLayNet (~400 MB) downloads on first run and takes 1-2 minutes to load. If you initialise the DocumentConverter inside the lifespan `yield`, uvicorn binds late and the workflow health check times out (port never opens in time).

**Fix:** Load the converter in a `ThreadPoolExecutor` submitted from the lifespan context, so uvicorn binds immediately. The `/extract` endpoint returns HTTP 503 with `Retry-After: 30` while loading is in progress; `extractWithDocling()` treats 503 as a fallback signal.

```python
@asynccontextmanager
async def lifespan(app):
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future = pool.submit(_load_converter_sync)
    future.add_done_callback(lambda f: set_global_converter(f.result()))
    yield
    pool.shutdown(wait=False)
```

## Server-to-server URL
`extractWithDocling()` calls `http://localhost:8000/docling-api/extract` **directly** (bypasses the shared proxy). This is intentional: the Docling service is internal-only and the proxy does not have an artifact.toml routing entry for `/docling-api`. Direct port access is correct for server→server calls within the same container.

## Artifact registration
`verifyAndReplaceArtifactToml` requires the **target** `artifact.toml` to already exist (it replaces in-place). For a brand-new Python service with no existing artifact.toml, use `configureWorkflow()` instead and skip artifact registration. The proxy routing is not needed for an internal sidecar.

## Docling v2 element API
```python
for item, _level in doc.iterate_items():
    label = item.label.value   # DocItemLabel enum → string, e.g. "text", "table", "picture", "page_header"
    text  = item.text or ""
    prov  = item.prov[0].page_no  # 1-based page number
```
Element label strings: `"text"`, `"section_header"`, `"list_item"`, `"table"`, `"picture"`, `"page_header"`, `"page_footer"`, `"key_value_item"`.
Tables have `.export_to_markdown()`.

## Printed page number extraction
Regex: `(?<![A-Za-z0-9\-])(\d{1,4})(?![A-Za-z0-9\-])` scanned **right-to-left** over page_header and page_footer text.
Right-to-left avoids matching model codes like "7220" in "S-7220C" (which appears before the page number in headers).
Stored in `manual_pages.printed_page_number TEXT` (nullable; NULL for pre-Docling manuals).

## Fallback chain
1. `extractWithDocling(pdfBuffer)` — tries Docling sidecar
2. If returns null (503, connection refused, timeout, 5xx) → `extractPdfText(pdfBuffer)` — pdf-parse
3. Pass 2 stores `printedPageNumber` only when non-null (no null stored for legacy manuals)
4. chat.ts / agentChat.ts do a post-retrieval lookup of `printed_page_number` for each chunk's page and use the display label in the LLM RAG context string

**Why:**  The printed page number is what the user sees in the physical manual; using it in the LLM context lets the model cite the correct page label (e.g. "page 7") instead of the PDF sequential page (e.g. "page 16").
