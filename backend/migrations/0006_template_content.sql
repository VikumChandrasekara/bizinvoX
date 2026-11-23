-- A saved template ("My templates") also keeps the parts of an invoice that stay the same from one invoice
-- to the next: the business details in the header, currency, payment terms and notes. Client, line items,
-- invoice number and dates are never stored. NULL for editor-managed templates and older saved ones.
ALTER TABLE templates ADD COLUMN content_json jsonb;
