-- Recycle bin: deleting an invoice or a saved template only sets `deleted_at`. The row stays for 30 days
-- (restorable), then the maintenance job removes it for good (see jobs.rs).
ALTER TABLE invoices ADD COLUMN deleted_at timestamptz;
ALTER TABLE templates ADD COLUMN deleted_at timestamptz;
CREATE INDEX invoices_deleted_at_idx ON invoices (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX templates_deleted_at_idx ON templates (deleted_at) WHERE deleted_at IS NOT NULL;
