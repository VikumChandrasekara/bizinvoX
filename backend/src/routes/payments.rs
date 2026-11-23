//! Watermark removal for Guest/Free users, and the PDF download endpoint.
//!
//! Anyone can download: without payment the PDF carries a tiled watermark.
//! Paying a small one-time fee for an invoice removes the watermark from that invoice's PDFs.
//!
//! 1. POST /invoices/{id}/checkout            -> Stripe Checkout URL
//! 2. Stripe webhook (or /checkout/confirm)    -> payment marked succeeded
//! 3. POST /invoices/{id}/checkout/confirm    -> single-use download token
//! 4. POST /invoices/{id}/download {token}    -> clean PDF (token consumed atomically)
//!
//! Without a token the download is free and watermarked, unless the invoice already has a
//! succeeded payment. Pro users always get a clean PDF.

use axum::{
    extract::{Path, State},
    response::Response,
    Json,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
use validator::Validate;

use crate::{
    cache,
    error::{AppError, AppResult, ValidJson},
    extract::Requester,
    models::PaymentStatus,
    routes::{invoices, pricing},
    security,
    state::AppState,
    stripe::DownloadCheckout,
};

const TOKEN_TTL_MINUTES: i64 = 15;
/// A payment can mint a few tokens so a failed/interrupted download can be
/// retried, without turning one payment into unlimited downloads.
const MAX_TOKENS_PER_PAYMENT: i64 = 3;

#[derive(Serialize, ToSchema)]
pub struct CheckoutResponse {
    pub url: String,
}

#[derive(Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConfirmRequest {
    #[validate(length(min = 10, max = 255))]
    pub session_id: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTokenResponse {
    pub download_token: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DownloadRequest {
    /// Required unless the requester is on Pro.
    #[validate(length(min = 20, max = 200))]
    pub token: Option<String>,
}

fn token_key(hash: &str) -> String {
    format!("download_token:{hash}")
}

/// Idempotent: marks the pending payment succeeded and the invoice paid.
pub async fn mark_download_paid(
    state: &AppState,
    checkout_session_id: &str,
    payment_intent: Option<&str>,
) -> AppResult<()> {
    sqlx::query(
        "WITH p AS (
            UPDATE payments
               SET status = 'succeeded',
                   stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
                   updated_at = now()
             WHERE stripe_checkout_session_id = $1 AND status = 'pending'
         RETURNING invoice_id)
         UPDATE invoices SET status = 'paid', updated_at = now()
          WHERE id IN (SELECT invoice_id FROM p) AND status = 'draft'",
    )
    .bind(checkout_session_id)
    .bind(payment_intent)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Burn every unused token tied to a payment (refunds).
pub async fn invalidate_tokens(state: &AppState, payment_id: Uuid) -> AppResult<()> {
    let hashes: Vec<String> = sqlx::query_scalar(
        "UPDATE download_tokens SET used_at = now()
          WHERE payment_id = $1 AND used_at IS NULL RETURNING token_hash",
    )
    .bind(payment_id)
    .fetch_all(&state.db)
    .await?;
    let keys: Vec<String> = hashes.iter().map(|h| token_key(h)).collect();
    cache::del(&state.redis, &keys).await;
    Ok(())
}

/// Mark a payment refunded and revoke its outstanding download tokens.
pub async fn mark_refunded(state: &AppState, payment_id: Uuid) -> AppResult<()> {
    sqlx::query("UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1")
        .bind(payment_id)
        .execute(&state.db)
        .await?;
    invalidate_tokens(state, payment_id).await
}

async fn mint_download_token(
    state: &AppState,
    invoice_id: Uuid,
    payment_id: Uuid,
) -> AppResult<(String, DateTime<Utc>)> {
    let token = security::random_token();
    let hash = security::sha256_hex(&token);
    let expires_at = Utc::now() + Duration::minutes(TOKEN_TTL_MINUTES);
    sqlx::query("INSERT INTO download_tokens (invoice_id, payment_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)")
        .bind(invoice_id)
        .bind(payment_id)
        .bind(&hash)
        .bind(expires_at)
        .execute(&state.db)
        .await?;
    cache::set_str(
        &state.redis,
        &token_key(&hash),
        &invoice_id.to_string(),
        (TOKEN_TTL_MINUTES * 60) as u64,
    )
    .await;
    Ok((token, expires_at))
}

#[utoipa::path(post, path = "/api/v1/invoices/{id}/checkout", tag = "payments",
    params(("id" = Uuid, Path, description = "Resource id")),
    responses((status = 200, body = CheckoutResponse), (status = 409, description = "Pro users don't need to pay")))]
pub async fn checkout(
    State(state): State<AppState>,
    requester: Requester,
    Path(id): Path<Uuid>,
) -> AppResult<Json<CheckoutResponse>> {
    let inv = invoices::load_owned(&state, &requester, id).await?;
    if requester.is_pro() {
        return Err(AppError::conflict(
            "not_required",
            "Pro accounts download without a watermark.",
        ));
    }
    if invoices::is_watermark_free(&state, &requester, inv.id).await? {
        return Err(AppError::conflict(
            "not_required",
            "The watermark has already been removed for this invoice.",
        ));
    }
    let price = pricing::load(&state).await?;
    let payment_id: Uuid = sqlx::query_scalar(
        "INSERT INTO payments (invoice_id, user_id, kind, amount_cents, currency)
         VALUES ($1, $2, 'single_download', $3, $4) RETURNING id",
    )
    .bind(inv.id)
    .bind(requester.user_id())
    .bind(price.download_price_cents)
    .bind(&price.currency)
    .fetch_one(&state.db)
    .await?;

    let origin = &state.config.app_origin;
    let session = state
        .stripe
        .create_download_checkout(DownloadCheckout {
            invoice_id: inv.id,
            payment_id,
            invoice_number: &inv.invoice_number,
            amount_cents: price.download_price_cents,
            currency: &price.currency,
            customer_email: requester.user().map(|u| u.user.email.as_str()),
            success_url: format!(
                "{origin}/?checkout=success&invoice={}&session_id={{CHECKOUT_SESSION_ID}}",
                inv.id
            ),
            cancel_url: format!("{origin}/?invoice={}&checkout=cancelled", inv.id),
        })
        .await?;
    sqlx::query(
        "UPDATE payments SET stripe_checkout_session_id = $1, updated_at = now() WHERE id = $2",
    )
    .bind(&session.id)
    .bind(payment_id)
    .execute(&state.db)
    .await?;
    Ok(Json(CheckoutResponse { url: session.url }))
}

/// Called by the frontend after Stripe redirects back. If the webhook hasn't
/// landed yet, we verify directly with Stripe (server-to-server) - the client's
/// word is never trusted.
#[utoipa::path(post, path = "/api/v1/invoices/{id}/checkout/confirm", tag = "payments",
    params(("id" = Uuid, Path, description = "Resource id")), request_body = ConfirmRequest,
    responses((status = 200, body = DownloadTokenResponse), (status = 402), (status = 409)))]
pub async fn confirm_checkout(
    State(state): State<AppState>,
    requester: Requester,
    Path(id): Path<Uuid>,
    ValidJson(req): ValidJson<ConfirmRequest>,
) -> AppResult<Json<DownloadTokenResponse>> {
    let inv = invoices::load_owned(&state, &requester, id).await?;
    let payment: Option<(Uuid, PaymentStatus)> = sqlx::query_as(
        "SELECT id, status FROM payments
          WHERE stripe_checkout_session_id = $1 AND invoice_id = $2 AND kind = 'single_download'",
    )
    .bind(&req.session_id)
    .bind(inv.id)
    .fetch_optional(&state.db)
    .await?;
    let (payment_id, mut status) = payment.ok_or_else(AppError::not_found)?;

    if status == PaymentStatus::Pending {
        let session = state
            .stripe
            .retrieve_checkout_session(&req.session_id)
            .await?;
        if session["payment_status"].as_str() == Some("paid") {
            mark_download_paid(&state, &req.session_id, session["payment_intent"].as_str()).await?;
            status = PaymentStatus::Succeeded;
        }
    }
    match status {
        PaymentStatus::Succeeded => {}
        PaymentStatus::Pending => {
            return Err(AppError::conflict(
                "payment_pending",
                "Payment is still processing. Try again in a moment.",
            ))
        }
        PaymentStatus::Failed | PaymentStatus::Refunded => {
            return Err(AppError::payment_required("This payment did not complete."))
        }
    }

    let issued: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM download_tokens WHERE payment_id = $1")
            .bind(payment_id)
            .fetch_one(&state.db)
            .await?;
    if issued >= MAX_TOKENS_PER_PAYMENT {
        return Err(AppError::conflict(
            "download_limit",
            "The downloads for this payment have been used. Upgrade to Pro for unlimited downloads.",
        ));
    }
    let (download_token, expires_at) = mint_download_token(&state, inv.id, payment_id).await?;
    Ok(Json(DownloadTokenResponse {
        download_token,
        expires_at,
    }))
}

#[utoipa::path(post, path = "/api/v1/invoices/{id}/download", tag = "payments",
    params(("id" = Uuid, Path, description = "Resource id")), request_body = DownloadRequest,
    responses((status = 200, content_type = "application/pdf"), (status = 402, description = "Payment required"),
              (status = 410, description = "Token already used or expired")))]
pub async fn download(
    State(state): State<AppState>,
    requester: Requester,
    Path(id): Path<Uuid>,
    ValidJson(req): ValidJson<DownloadRequest>,
) -> AppResult<Response> {
    let inv = invoices::load_owned(&state, &requester, id).await?;
    let is_pro = requester.is_pro();

    // Everyone can download. Pro, a paid-off invoice, or a freshly minted token gives a clean PDF;
    // otherwise the PDF carries the watermark. A token is validated (without consuming) before rendering.
    let mut token_hash: Option<String> = None;
    let watermark = if is_pro {
        false
    } else if let Some(token) = req.token {
        let hash = security::sha256_hex(&token);
        let valid: bool = sqlx::query_scalar(
            "SELECT EXISTS (
                SELECT 1 FROM download_tokens t JOIN payments p ON p.id = t.payment_id
                 WHERE t.token_hash = $1 AND t.invoice_id = $2 AND t.used_at IS NULL
                   AND t.expires_at > now() AND p.status = 'succeeded')",
        )
        .bind(&hash)
        .bind(inv.id)
        .fetch_one(&state.db)
        .await?;
        if !valid {
            return Err(AppError::gone(
                "token_invalid",
                "This download link was already used or has expired.",
            ));
        }
        token_hash = Some(hash);
        false
    } else {
        !invoices::is_watermark_free(&state, &requester, inv.id).await?
    };

    let bytes = invoices::render_pdf(&state, &inv, is_pro, watermark).await?;

    // Consume only after a successful render so a failure doesn't burn the
    // token. Postgres is the single-use authority (atomic conditional UPDATE);
    // Redis GETDEL clears the mirrored entry.
    if let Some(hash) = token_hash {
        let _ = cache::get_del(&state.redis, &token_key(&hash)).await;
        let consumed = sqlx::query(
            "UPDATE download_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL",
        )
        .bind(&hash)
        .execute(&state.db)
        .await?
        .rows_affected();
        if consumed != 1 {
            return Err(AppError::gone(
                "token_invalid",
                "This download link was already used.",
            ));
        }
    }
    // Every successful download is recorded, so "My Invoices" can show it. This does not touch `status`.
    sqlx::query("UPDATE invoices SET downloaded_at = now() WHERE id = $1")
        .bind(inv.id)
        .execute(&state.db)
        .await?;
    // A watermarked download is free and must not lock the invoice for editing.
    if !watermark {
        sqlx::query("UPDATE invoices SET status = 'downloaded', updated_at = now() WHERE id = $1 AND status <> 'downloaded'")
            .bind(inv.id)
            .execute(&state.db)
            .await?;
    }
    Ok(invoices::pdf_response(bytes, &inv.invoice_number, false))
}
