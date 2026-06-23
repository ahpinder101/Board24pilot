-- Pipeline stage rename (v2) + manual_pages.page_type
ALTER TABLE manuals ADD COLUMN IF NOT EXISTS pipeline_stage_version integer NOT NULL DEFAULT 1;
ALTER TABLE manual_pages ADD COLUMN IF NOT EXISTS page_type text;
