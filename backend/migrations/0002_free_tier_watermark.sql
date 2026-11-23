-- Free tier: watermarked downloads, $0.99 to remove the watermark, customization for everyone.

-- Guests and Free accounts have no templates of their own, so their Classic customizations
-- (colors, fonts, removed fields, logo) live on the invoice itself. Pro keeps using templates.
ALTER TABLE invoices
    ADD COLUMN layout_json jsonb,
    ADD COLUMN logo_png    bytea;      -- re-encoded, sanitised PNG (same rules as template logos)

-- Prices (cents): watermark removal $0.99, Pro $5.99/month, Pro yearly = 12 months less 27%
-- (5.99 * 12 * 0.73 = 52.47).
UPDATE pricing_config
   SET download_price_cents = 99,
       pro_monthly_cents    = 599,
       pro_annual_cents     = 5247,
       updated_at           = now()
 WHERE id = 1;
