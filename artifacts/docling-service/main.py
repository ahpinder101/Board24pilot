"""
Docling PDF Extraction Service
FastAPI sidecar that converts PDFs into structured JSON using IBM's Docling library.
The DocLayNet model is loaded in a background thread at startup so uvicorn binds
to its port immediately (health check passes), and /extract requests that arrive
before loading completes receive a 503 with a Retry-After header.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import os
import re
import tempfile
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_PATH = os.environ.get("BASE_PATH", "/docling-api")

_converter: Any = None          # set by background load
_load_future: concurrent.futures.Future | None = None


def _load_converter_sync() -> Any:
    """Blocking build — runs in a thread-pool executor."""
    logger.info("Building Docling converter (first run downloads ~400 MB model)…")
    try:
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.datamodel.base_models import InputFormat

        opts = PdfPipelineOptions()
        opts.do_ocr = False
        opts.do_table_structure = True

        conv = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
        )
        logger.info("Docling converter ready ✓")
        return conv
    except Exception as exc:
        logger.warning("Detailed Docling init failed (%s); using default settings", exc)
        from docling.document_converter import DocumentConverter
        return DocumentConverter()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _converter, _load_future
    loop = asyncio.get_event_loop()
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    _load_future = pool.submit(_load_converter_sync)

    def _on_done(fut: concurrent.futures.Future):
        global _converter
        try:
            _converter = fut.result()
        except Exception as exc:
            logger.error("Converter load failed: %s", exc)

    _load_future.add_done_callback(_on_done)
    yield
    pool.shutdown(wait=False)
    _converter = None


app = FastAPI(title="Docling PDF Extraction Service", lifespan=lifespan)


# ── Helpers ─────────────────────────────────────────────────────────────────

def _label(item: Any) -> str:
    try:
        return item.label.value
    except AttributeError:
        return re.sub(r"item$", "", type(item).__name__.lower())


def _text(item: Any) -> str:
    return (getattr(item, "text", None) or "").strip()


def _extract_printed_page_number(hf_texts: list[str]) -> Optional[str]:
    """
    Extract the human-readable page number from page header/footer text.
    Looks right-to-left for a standalone 1–4-digit number not glued to letters
    (to avoid matching the model code "7220" inside "S-7220C").
    """
    for text in hf_texts:
        nums = re.findall(r"(?<![A-Za-z0-9\-])(\d{1,4})(?![A-Za-z0-9\-])", text)
        for num_str in reversed(nums):
            n = int(num_str)
            if 1 <= n <= 9999:
                return num_str
    return None


def _has_multiple_page_candidates(text: str) -> bool:
    """
    Returns True when a text string contains ≥ 2 standalone numbers — a
    signal that the line is a combined page-header (model code + section
    number + printed page number) rather than a plain section title like
    "2. INSTALLATION" which has only one number.
    """
    nums = re.findall(r"(?<![A-Za-z0-9\-])(\d{1,4})(?![A-Za-z0-9\-])", text)
    return len(nums) >= 2


# ── Routes ──────────────────────────────────────────────────────────────────

@app.get(f"{BASE_PATH}/healthz")
async def healthz():
    return {"status": "ok", "ready": _converter is not None}


@app.post(f"{BASE_PATH}/extract")
async def extract_pdf(file: UploadFile = File(...)):
    if _converter is None:
        # Still loading — tell the client to retry in 30 s
        from fastapi.responses import Response
        return Response(
            status_code=503,
            headers={"Retry-After": "30"},
            content='{"detail":"Model still loading — retry shortly"}',
            media_type="application/json",
        )

    raw = await file.read()
    logger.info("Received PDF: %d bytes", len(raw))

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name

    try:
        result = _converter.convert(tmp_path)
        doc = result.document

        pages_map: dict[int, dict] = {}

        for item, _level in doc.iterate_items():
            prov = getattr(item, "prov", None)
            if not prov:
                continue

            page_no: int = prov[0].page_no
            if page_no not in pages_map:
                pages_map[page_no] = {
                    "pageNumber": page_no,
                    "printedPageNumber": None,
                    "text": "",
                    "elements": [],
                    "hasImages": False,
                    "hasTables": False,
                    "_hf": [],
                }

            pd = pages_map[page_no]
            lbl = _label(item)
            txt = _text(item)
            entry: dict = {"type": lbl, "text": txt}

            lvl = getattr(item, "level", None)
            if lvl is not None:
                try:
                    entry["level"] = int(lvl)
                except (TypeError, ValueError):
                    pass

            if lbl == "table":
                pd["hasTables"] = True
                try:
                    entry["markdown"] = item.export_to_markdown()
                except Exception:
                    entry["markdown"] = txt
            elif lbl == "picture":
                pd["hasImages"] = True
                cap = getattr(item, "caption", None)
                if cap:
                    entry["caption"] = str(cap)
            elif lbl in ("page_header", "page_footer"):
                if txt:
                    pd["_hf"].append(txt)
                pd["elements"].append(entry)
                continue  # headers/footers not added to body text

            pd["elements"].append(entry)
            if txt:
                pd["text"] = (pd["text"] + "\n" + txt) if pd["text"] else txt

        for pd in pages_map.values():
            hf_texts = pd.pop("_hf", [])
            printed = _extract_printed_page_number(hf_texts)

            # Secondary scan: Docling sometimes classifies combined page-header lines
            # (e.g. "S-7220C 2. INSTALLATION 7 2-3. Lubrication") as section_header
            # elements instead of page_header/page_footer. Detect them by requiring
            # ≥ 2 standalone numbers in the text (plain section titles like
            # "2. INSTALLATION" have only one number and are skipped).
            if printed is None:
                for el in pd.get("elements", [])[:3]:
                    if el.get("type") == "section_header" and el.get("text"):
                        if _has_multiple_page_candidates(el["text"]):
                            candidate = _extract_printed_page_number([el["text"]])
                            if candidate:
                                printed = candidate
                                break

            pd["printedPageNumber"] = printed

        pages = sorted(pages_map.values(), key=lambda p: p["pageNumber"])

        # Use the actual physical page count from the Docling document model.
        # len(pages) only counts pages that had extractable text/table/picture
        # elements — purely image-based or blank pages are skipped by
        # iterate_items() and never added to pages_map, so they'd be undercounted.
        # doc.pages is populated for every physical page in the PDF.
        physical_page_count = len(doc.pages) if doc.pages else len(pages)

        return JSONResponse(
            {"pages": pages, "fullText": doc.export_to_text(), "totalPages": physical_page_count}
        )

    except Exception as exc:
        logger.exception("PDF extraction failed")
        raise HTTPException(status_code=500, detail=f"Extraction failed: {exc}") from exc

    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
