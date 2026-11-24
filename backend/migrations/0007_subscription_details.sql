-- What the "Manage subscription" page shows, kept in step with Stripe by the webhook
-- (and by the cancel / resume / confirm endpoints). Stripe stays the source of truth;
-- these columns let the page load without a live Stripe call.
ALTER TABLE users
    ADD COLUMN subscription_status   text,                              -- Stripe status: active, trialing, past_due, canceled, ...
    ADD COLUMN plan_interval         text CHECK (plan_interval IN ('monthly', 'annual')),
    ADD COLUMN plan_amount_cents     integer CHECK (plan_amount_cents >= 0),
    ADD COLUMN plan_currency         text CHECK (plan_currency ~ '^[A-Z]{3}$'),
    ADD COLUMN cancel_at_period_end  boolean NOT NULL DEFAULT false,    -- true: Pro until plan_renews_at, then back to Free
    ADD COLUMN subscribed_at         timestamptz;                       -- when the current subscription started

-- Link to the hosted Stripe receipt for a subscription payment.
ALTER TABLE payments ADD COLUMN receipt_url text;
