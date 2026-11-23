use axum::{extract::State, Json};

use crate::{cache, error::AppResult, models::Pricing, state::AppState};

pub const PRICING_KEY: &str = "pricing:config";
const PRICING_TTL: u64 = 300;

/// Read-through cache over the single `pricing_config` row.
pub async fn load(state: &AppState) -> AppResult<Pricing> {
    if let Some(p) = cache::get_json::<Pricing>(&state.redis, PRICING_KEY).await {
        return Ok(p);
    }
    let pricing = sqlx::query_as::<_, Pricing>(
        "SELECT download_price_cents, currency, pro_monthly_cents, pro_annual_cents FROM pricing_config WHERE id = 1",
    )
    .fetch_one(&state.db)
    .await?;
    cache::set_json(&state.redis, PRICING_KEY, &pricing, PRICING_TTL).await;
    Ok(pricing)
}

#[utoipa::path(get, path = "/api/v1/pricing", tag = "billing", responses((status = 200, body = Pricing)))]
pub async fn get_pricing(State(state): State<AppState>) -> AppResult<Json<Pricing>> {
    Ok(Json(load(&state).await?))
}
