-- When an invoice's PDF was last downloaded (watermarked or not). `status` can't carry this: a free,
-- watermarked download must not lock the invoice for editing, but "My Invoices" should still show that
-- the invoice has been downloaded.
ALTER TABLE invoices ADD COLUMN downloaded_at timestamptz;
