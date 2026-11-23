//! Pro subscription via Stripe Billing (hosted Checkout + Customer Portal).

use axum::{extract::State, Json};
use serde::Deserialize;
use utoipa::ToSchema;
use validator::Validate;

use crate::{
    error::{AppError, AppResult, ValidJson},
    extract::AuthUser,
    routes::payments::CheckoutResponse,
    state::AppState,
};

#[derive(Debug, Clone, Copy, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum BillingInterval {
    Monthly,
    Annual,
}

#[derive(Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SubscribeRequest {
    pub interval: BillingInterval,
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
            "You're already on Pro. Manage billing from the portal.",
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

    let session = state
        .stripe
        .create_subscription_checkout(
            &customer,
            price,
            user.id(),
            format!("{}/?billing=success", cfg.app_origin),
            format!("{}/?checkout=cancelled", cfg.app_origin),
        )
        .await?;
    Ok(Json(CheckoutResponse { url: session.url }))
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
        .create_portal_session(
            customer,
            format!("{}/", state.config.app_origin),
        )
        .await?;
    Ok(Json(CheckoutResponse { url }))
}
