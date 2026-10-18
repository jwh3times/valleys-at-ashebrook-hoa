-- #290 slice 1: who uploaded or imported a document. Plain text with no FK, like
-- every other actor column (docs/agents/data-model.md), so removing an Account
-- never erases attribution. NULL means "not recorded": every row that predates
-- this migration, including the offline corpus import.
-- Apply BEFORE merging the code that writes it: uploads and the admin list both
-- read and write the column, as with 0033.
ALTER TABLE documents ADD COLUMN uploaded_by TEXT;
