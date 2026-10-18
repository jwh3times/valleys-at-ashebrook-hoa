-- #290 slice 1: who uploaded or imported a document. Plain text with no FK, like
-- every other actor column (docs/agents/data-model.md), so removing an Account
-- never erases attribution. NULL means "not recorded": every row that predates
-- this migration, including the offline corpus import.
-- Apply BEFORE merging the code that uses it, as with 0033: uploads insert the
-- column and the admin document list joins on it, so both fail until it exists.
-- Downloads read an explicit projection and are unaffected.
ALTER TABLE documents ADD COLUMN uploaded_by TEXT;
