-- #294 slice 1 (ADR 0028, spec 2026-10-20 decision 1): the board marks a
-- homeowner-tier document Tenant-Visible, and a tenant then sees it beside the
-- public documents. The CHECK keeps the mark on homeowner documents only: a
-- public document needs none, and a board document must never carry one. The
-- default satisfies it for every existing row, so no rebuild is needed.
-- Apply BEFORE merging the code that uses it, as with 0033 and 0039: the
-- document list, the download and the admin list all read the column, so every
-- one of them fails until it exists.
ALTER TABLE documents ADD COLUMN tenant_visible INTEGER NOT NULL DEFAULT 0
  CHECK (tenant_visible IN (0, 1) AND (tenant_visible = 0 OR visibility = 'homeowner'));
