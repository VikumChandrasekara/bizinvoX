//! Pro subscription via Stripe Billing: hosted Checkout, the Customer Portal, and the
//! data behind the "Manage subscription" page (status, renewal, card, receipts, cancel / resume).

use axum::{extract::State, Json};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;
use validator::Validate;

use crate::{
    error::{AppError, AppResult, ValidJson},
    extract::AuthUser,
    models::{PaymentStatus, Plan},
    routes::{payments::CheckoutResponse, webhooks},
    state::AppState,
};

#[derive(Debug, Clone, Copy, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum BillingInterval {
    Monthly,
    Annual,
}

impl BillingInterval {
    fn as_str(self) -> &'static str {
        match self {
            BillingInterval::Monthly => "monthly",
            BillingInterval::Annual => "annual",
        }
    }
}

#[derive(Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SubscribeRequest {
    pub interval: BillingInterval,
}

#[derive(Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConfirmSubscriptionRequest {
    /// The Stripe Checkout session id Stripe put in the return URL.
    #[validate(length(min = 10, max = 255))]
    pub session_id: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CardDto {
    pub brand: String,
    pub last4: String,
    pub exp_month: i64,
    pub exp_year: i64,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageDto {
    /// Invoices saved to the account (not in the recycle bin).
    pub invoices: i64,
    /// Templates the user saved ("My templates").
    pub templates: i64,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PaymentDto {
    pub id: Uuid,
    /// `single_download` or `pro_subscription`.
    pub kind: String,
    pub description: String,
    pub amount_cents: i32,
    pub currency: String,
    pub status: PaymentStatus,
    pub created_at: DateTime<Utc>,
    /// Hosted Stripe receipt, when there is one.
    pub receipt_url: Option<String>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionDto {
    pub plan: Plan,
    /// Stripe's subscription status (`active`, `trialing`, `past_due`, `canceled`), when there has been one.
    pub status: Option<String>,
    /// `monthly` or `annual` while on Pro.
    pub interval: Option<String>,
    /// What each billing period costs, in cents.
    pub amount_cents: Option<i32>,
    pub currency: Option<String>,
    /// The next renewal, or (when `cancelAtPeriodEnd`) the moment Pro ends.
    pub renews_at: Option<DateTime<Utc>>,
    pub cancel_at_period_end: bool,
    pub started_at: Option<DateTime<Utc>>,
    pub has_billing_account: bool,
    /// False when this server has no Stripe keys, so no payment can be made.
    pub payments_configured: bool,
    pub card: Option<CardDto>,
    pub usage: UsageDto,
    pub payments: Vec<PaymentDto>,
}

#[derive(FromRow)]
struct SubscriptionRow {
    plan: Plan,
    subscription_status: Option<String>,
    plan_interval: Option<String>,
    plan_amount_cents: Option<i32>,
    plan_currency: Option<String>,
    plan_renews_at: Option<DateTime<Utc>>,
    cancel_at_period_end: bool,
    subscribed_at: Option<DateTime<Utc>>,
    stripe_customer_id: Option<String>,
    stripe_subscription_id: Option<String>,
}

#[derive(FromRow)]
struct PaymentRow {
    id: Uuid,
    kind: String,
    amount_cents: i32,
    currency: String,
    status: PaymentStatus,
    created_at: DateTime<Utc>,
    receipt_url: Option<String>,
    invoice_number: Option<String>,
}

/// Everything the Manage subscription page shows, read fresh from the database (plus the card from Stripe).
async fn build(state: &AppState, user_id: Uuid) -> AppResult<SubscriptionDto> {
    let row = sqlx::query_as::<_, SubscriptionRow>(
        "SELECT plan, subscription_status, plan_interval, plan_amount_cents, plan_currency,
                plan_renews_at, cancel_at_period_end, subscribed_at,
                stripe_customer_id, stripe_subscription_id
           FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    let payments = sqlx::query_as::<_, PaymentRow>(
        "SELECT p.id, p.kind::text AS kind, p.amount_cents, p.currency, p.status, p.created_at,
                p.receipt_url, i.invoice_number
           FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
          WHERE p.user_id = $1 AND p.status IN ('succeeded', 'refunded')
          ORDER BY p.created_at DESC LIMIT 50",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    let invoices: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM invoices WHERE user_id = $1 AND deleted_at IS NULL",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    let templates: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM templates WHERE user_id = $1 AND saved AND deleted_at IS NULL",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    let card = match (&row.stripe_customer_id, row.plan) {
        (Some(customer), Plan::Pro) if state.stripe.is_configured() => state
            .stripe
            .default_card(customer, row.stripe_subscription_id.as_deref())
            .await
            .and_then(|c| {
                Some(CardDto {
                    brand: c["brand"].as_str()?.to_owned(),
                    last4: c["last4"].as_str()?.to_owned(),
                    exp_month: c["exp_month"].as_i64()?,
                    exp_year: c["exp_year"].as_i64()?,
                })
            }),
        _ => None,
    };

    Ok(SubscriptionDto {
        plan: row.plan,
        status: row.subscription_status,
        interval: row.plan_interval,
        amount_cents: row.plan_amount_cents,
        currency: row.plan_currency,
        renews_at: row.plan_renews_at,
        cancel_at_period_end: row.cancel_at_period_end,
        started_at: row.subscribed_at,
        has_billing_account: row.stripe_customer_id.is_some(),
        payments_configured: state.stripe.is_configured(),
        card,
        usage: UsageDto {
            invoices,
            templates,
        },
        payments: payments
            .into_iter()
            .map(|p| PaymentDto {
                id: p.id,
                description: match (p.kind.as_str(), p.invoice_number) {
                    ("single_download", Some(n)) => format!("Watermark removal, invoice {n}"),
                    ("single_download", None) => "Watermark removal".to_owned(),
                    _ => "Pro subscription".to_owned(),
                },
                kind: p.kind,
                amount_cents: p.amount_cents,
                currency: p.currency,
                status: p.status,
                created_at: p.created_at,
                receipt_url: p.receipt_url,
            })
            .collect(),
    })
}

#[utoipa::path(get, path = "/api/v1/billing/subscription", tag = "billing",
    responses((status = 200, body = SubscriptionDto), (status = 401)))]
pub async fn subscription(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<SubscriptionDto>> {
    Ok(Json(build(&state, user.id()).await?))
}

#[utoipa::path(post, path = "/api/v1/billing/subscribe", tag = "billing", request_body = SubscribeRequest,
    responses((status = 200, body = CheckoutResponse), (status = 409, description = "Already Pro")))]
pub async fn subscribe(
    State(state): State<AppState>,
    user: AuthUser,
    ValidJson(req): ValidJson<SubscribeRequest>,
) -> AppResult<Json<CheckoutResponse>> {
    if user.is_pro() {
        return Err(AppError::conflict(
            "already_pro",
            "You're already on Pro. Manage your subscription from the billing page.",
        ));
    }
    let cfg = &state.config;
    let price = match req.interval {
        BillingInterval::Monthly => cfg.stripe_price_pro_monthly.as_deref(),
        BillingInterval::Annual => cfg.stripe_price_pro_annual.as_deref(),
    }
    .ok_or_else(|| {
        AppError::unavailable(
            "payments_unavailable",
            "Subscriptions are not configured on this server.",
        )
    })?;

    let customer = match user.user.stripe_customer_id.clone() {
        Some(c) => c,
        None => {
            let c = state
                .stripe
                .create_customer(&user.user.email, user.id())
                .await?;
            sqlx::query("UPDATE users SET stripe_customer_id = $1, updated_at = now() WHERE id = $2 AND stripe_customer_id IS NULL")
                .bind(&c)
                .bind(user.id())
                .execute(&state.db)
                .await?;
            c
        }
    };

    let origin = &cfg.app_origin;
    let session = state
        .stripe
        .create_subscription_checkout(
            &customer,
            price,
            user.id(),
            // The billing page confirms the session with Stripe, so Pro shows up even if the webhook is late.
            format!("{origin}/billing?checkout=success&session_id={{CHECKOUT_SESSION_ID}}"),
            format!("{origin}/checkout?plan={}&cancelled=1", req.interval.as_str()),
        )
        .await?;
    Ok(Json(CheckoutResponse { url: session.url }))
}

/// Called by the billing page after Stripe sends the customer back. Asks Stripe directly (the
/// redirect is never trusted) and syncs the plan, so Pro appears even before the webhook lands.
#[utoipa::path(post, path = "/api/v1/billing/confirm", tag = "billing", request_body = ConfirmSubscriptionRequest,
    responses((status = 200, body = SubscriptionDto), (status = 404), (status = 409, description = "Payment still processing")))]
pub async fn confirm(
    State(state): State<AppState>,
    user: AuthUser,
    ValidJson(req): ValidJson<ConfirmSubscriptionRequest>,
) -> AppResult<Json<SubscriptionDto>> {
    let session = state
        .stripe
        .retrieve_checkout_session(&req.session_id)
        .await?;
    // Only the customer who started this checkout can confirm it.
    let mine = session["mode"].as_str() == Some("subscription")
        && session["customer"].as_str().is_some()
        && session["customer"].as_str() == user.user.stripe_customer_id.as_deref();
    if !mine {
        return Err(AppError::not_found());
    }
    let done = session["status"].as_str() == Some("complete")
        && matches!(
            session["payment_status"].as_str(),
            Some("paid") | Some("no_payment_required")
        );
    let Some(sub_id) = session["subscription"].as_str().filter(|_| done) else {
        return Err(AppError::conflict(
            "payment_pending",
            "Your payment is still processing. This usually takes a few seconds.",
        ));
    };
    let sub = state.stripe.retrieve_subscription(sub_id).await?;
    webhooks::sync_subscription(&state, &sub).await?;
    Ok(Json(build(&state, user.id()).await?))
}

/// Shared by cancel and resume: flip the renewal flag at Stripe, then sync what it reports back.
async fn set_cancellation(
    state: &AppState,
    user: &AuthUser,
    cancel: bool,
) -> AppResult<Json<SubscriptionDto>> {
    let sub_id: Option<String> =
        sqlx::query_scalar("SELECT stripe_subscription_id FROM users WHERE id = $1")
            .bind(user.id())
            .fetch_one(&state.db)
            .await?;
    let sub_id = sub_id.filter(|_| user.is_pro()).ok_or_else(|| {
        AppError::conflict("no_subscription", "You don't have an active subscription.")
    })?;
    let sub = state
        .stripe
        .set_cancel_at_period_end(&sub_id, cancel)
        .await?;
    webhooks::sync_subscription(state, &sub).await?;
    Ok(Json(build(state, user.id()).await?))
}

#[utoipa::path(post, path = "/api/v1/billing/cancel", tag = "billing",
    responses((status = 200, body = SubscriptionDto), (status = 409, description = "No active subscription")))]
pub async fn cancel(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<SubscriptionDto>> {
    set_cancellation(&state, &user, true).await
}

#[utoipa::path(post, path = "/api/v1/billing/resume", tag = "billing",
    responses((status = 200, body = SubscriptionDto), (status = 409, description = "No active subscription")))]
pub async fn resume(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<SubscriptionDto>> {
    set_cancellation(&state, &user, false).await
}

#[utoipa::path(post, path = "/api/v1/billing/portal", tag = "billing",
    responses((status = 200, body = CheckoutResponse), (status = 409, description = "No billing account yet")))]
pub async fn portal(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<CheckoutResponse>> {
    let customer = user.user.stripe_customer_id.as_deref().ok_or_else(|| {
        AppError::conflict(
            "no_billing_account",
            "You don't have a billing account yet.",
        )
    })?;
    let url = state
        .stripe
        .create_portal_session(customer, format!("{}/billing", state.config.app_origin))
        .await?;
    Ok(Json(CheckoutResponse { url }))
}
