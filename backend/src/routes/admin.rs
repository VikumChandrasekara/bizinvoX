//! Admin-only operations: refunds and pricing changes.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use utoipa::ToSchema;
use uuid::Uuid;
use validator::Validate;

use crate::{
    cache,
    error::{AppError, AppResult, ValidJson},
    extract::AuthUser,
    models::{PaymentStatus, Pricing},
    routes::{payments, pricing::PRICING_KEY},
    state::AppState,
};

fn require_admin(user: &AuthUser) -> AppResult<()> {
    if user.user.is_admin {
        Ok(())
    } else {
        Err(AppError::forbidden(
            "admin_required",
            "Administrator access required.",
        ))
    }
}

#[derive(Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PricingInput {
    #[validate(range(min = 50, max = 10_000))]
    pub download_price_cents: i32,
    #[validate(length(equal = 3))]
    pub currency: String,
    #[validate(range(min = 0, max = 100_000))]
    pub pro_monthly_cents: i32,
    #[validate(range(min = 0, max = 1_000_000))]
    pub pro_annual_cents: i32,
}

#[utoipa::path(post, path = "/api/v1/admin/payments/{id}/refund", tag = "admin",
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 204), (status = 403), (status = 409)))]
pub async fn refund(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    require_admin(&user)?;
    let payment: Option<(Option<String>, PaymentStatus)> =
        sqlx::query_as("SELECT stripe_payment_intent_id, status FROM payments WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let (intent, status) = payment.ok_or_else(AppError::not_found)?;
    if status != PaymentStatus::Succeeded {
        return Err(AppError::conflict(
            "not_refundable",
            "Only succeeded payments can be refunded.",
        ));
    }
    let intent = intent.ok_or_else(|| {
        AppError::conflict("not_refundable", "Payment has no Stripe payment intent.")
    })?;
    state
        .stripe
        .refund(&intent, &format!("refund-{id}"))
        .await?;
    payments::mark_refunded(&state, id).await?;
    tracing::info!(payment_id = %id, admin = %user.id(), "payment refunded");
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(put, path = "/api/v1/admin/pricing", tag = "admin", request_body = PricingInput,
    responses((status = 200, body = Pricing), (status = 403)))]
pub async fn update_pricing(
    State(state): State<AppState>,
    user: AuthUser,
    ValidJson(input): ValidJson<PricingInput>,
) -> AppResult<Json<Pricing>> {
    require_admin(&user)?;
    let pricing = sqlx::query_as::<_, Pricing>(
        "UPDATE pricing_config SET download_price_cents = $1, currency = $2, pro_monthly_cents = $3,
                pro_annual_cents = $4, updated_at = now()
          WHERE id = 1
          RETURNING download_price_cents, currency, pro_monthly_cents, pro_annual_cents",
    )
    .bind(input.download_price_cents)
    .bind(input.currency.to_ascii_uppercase())
    .bind(input.pro_monthly_cents)
    .bind(input.pro_annual_cents)
    .fetch_one(&state.db)
    .await?;
    cache::del(&state.redis, &[PRICING_KEY.to_owned()]).await;
    Ok(Json(pricing))
}
