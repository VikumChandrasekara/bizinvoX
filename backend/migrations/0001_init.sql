-- Business Invoice Generator - initial schema
-- Postgres is the system of record; Redis only caches/ephemeral state.

CREATE TYPE user_plan AS ENUM ('free', 'pro');
CREATE TYPE invoice_status AS ENUM ('draft', 'paid', 'downloaded');
CREATE TYPE payment_kind AS ENUM ('single_download', 'pro_subscription');
CREATE TYPE payment_status AS ENUM ('pending', 'succeeded', 'failed', 'refunded');
CREATE TYPE email_token_kind AS ENUM ('verify_email', 'password_reset');

-- Emails are normalised (trimmed + lowercased) by the API before storage,
-- so a plain unique index gives case-insensitive uniqueness.
CREATE TABLE users (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email                  text NOT NULL CHECK (email = lower(email)),
    password_hash          text NOT NULL,            -- Argon2id PHC string ($argon2id$...), salt embedded
    plan                   user_plan NOT NULL DEFAULT 'free',
    plan_renews_at         timestamptz,
    stripe_customer_id     text,
    stripe_subscription_id text,
    email_verified_at      timestamptz,
    is_admin               boolean NOT NULL DEFAULT false,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE UNIQUE INDEX users_stripe_customer_key ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE sessions (
    id                 uuid PRIMARY KEY,
    user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    refresh_token_hash text NOT NULL,                -- SHA-256 of the refresh token, never the token itself
    expires_at         timestamptz NOT NULL,
    user_agent         text,
    ip_hash            text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    last_used_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sessions_refresh_token_hash_key ON sessions (refresh_token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid REFERENCES users (id) ON DELETE CASCADE,  -- NULL only for the system default
    name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    is_default  boolean NOT NULL DEFAULT false,
    layout_json jsonb NOT NULL,
    logo_png    bytea,                                         -- re-encoded, sanitised PNG
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT default_template_is_system CHECK (NOT is_default OR user_id IS NULL),
    CONSTRAINT custom_template_has_owner CHECK (is_default OR user_id IS NOT NULL)
);
CREATE UNIQUE INDEX templates_single_default ON templates (is_default) WHERE is_default;
CREATE INDEX templates_user_id_idx ON templates (user_id, updated_at DESC);

CREATE TABLE invoices (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid REFERENCES users (id) ON DELETE CASCADE,
    template_id    uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
                   REFERENCES templates (id) ON DELETE SET DEFAULT,
    guest_token    text,                                       -- unguessable guest session id (HMAC-signed in the cookie)
    status         invoice_status NOT NULL DEFAULT 'draft',
    invoice_number text NOT NULL CHECK (char_length(invoice_number) BETWEEN 1 AND 40),
    issue_date     date NOT NULL,
    due_date       date,
    currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    business_info  jsonb NOT NULL,
    client_info    jsonb NOT NULL,
    line_items     jsonb NOT NULL,
    subtotal       numeric(12, 2) NOT NULL,
    tax_total      numeric(12, 2) NOT NULL,
    discount_total numeric(12, 2) NOT NULL,
    grand_total    numeric(12, 2) NOT NULL,
    notes          text,
    payment_terms  text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT invoice_has_owner CHECK (user_id IS NOT NULL OR guest_token IS NOT NULL)
);
CREATE INDEX invoices_user_id_idx ON invoices (user_id, created_at DESC, id DESC) WHERE user_id IS NOT NULL;
CREATE INDEX invoices_guest_token_idx ON invoices (guest_token) WHERE guest_token IS NOT NULL;
CREATE INDEX invoices_template_id_idx ON invoices (template_id);

CREATE TABLE payments (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id                 uuid REFERENCES invoices (id) ON DELETE SET NULL,  -- NULL for subscriptions
    user_id                    uuid REFERENCES users (id) ON DELETE SET NULL,     -- NULL for guests
    stripe_checkout_session_id text,
    stripe_payment_intent_id   text,
    stripe_invoice_id          text,
    kind                       payment_kind NOT NULL,
    amount_cents               integer NOT NULL CHECK (amount_cents >= 0),
    currency                   text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    status                     payment_status NOT NULL DEFAULT 'pending',
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_checkout_session_key ON payments (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX payments_stripe_invoice_key ON payments (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;
CREATE INDEX payments_invoice_id_idx ON payments (invoice_id);
CREATE INDEX payments_user_id_idx ON payments (user_id);
CREATE INDEX payments_payment_intent_idx ON payments (stripe_payment_intent_id);

CREATE TABLE download_tokens (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id uuid NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
    payment_id uuid NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
    token_hash text NOT NULL,                   -- SHA-256 of the single-use token
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX download_tokens_hash_key ON download_tokens (token_hash);
CREATE INDEX download_tokens_invoice_id_idx ON download_tokens (invoice_id);
CREATE INDEX download_tokens_payment_id_idx ON download_tokens (payment_id);

CREATE TABLE email_tokens (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind       email_token_kind NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_tokens_hash_key ON email_tokens (token_hash);
CREATE INDEX email_tokens_user_id_idx ON email_tokens (user_id, kind);

-- Single-row pricing table, editable by admins, cached in Redis as pricing:config.
CREATE TABLE pricing_config (
    id                   smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    download_price_cents integer NOT NULL CHECK (download_price_cents > 0),
    currency             text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    pro_monthly_cents    integer NOT NULL CHECK (pro_monthly_cents >= 0),
    pro_annual_cents     integer NOT NULL CHECK (pro_annual_cents >= 0),
    updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pricing_config (id, download_price_cents, currency, pro_monthly_cents, pro_annual_cents)
VALUES (1, 199, 'USD', 900, 7900);

-- The one system default template available to every tier.
INSERT INTO templates (id, user_id, name, is_default, layout_json)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    NULL,
    'Classic',
    true,
    '{
        "font": "helvetica",
        "primaryColor": "#2E3A8C",
        "accentColor": "#10B981",
        "textColor": "#111827",
        "headerStyle": "band",
        "logoPosition": "none",
        "showTaxColumn": true,
        "showDiscountColumn": true,
        "titleText": "INVOICE",
        "footerText": "Thank you for your business.",
        "customFields": [],
        "density": "comfortable"
    }'::jsonb
);
