use axum::{extract::State, http::StatusCode, Json};
use serde_json::{json, Value};

use crate::state::AppState;

/// Liveness + dependency check for load balancers and uptime monitors.
#[utoipa::path(get, path = "/health", tag = "health",
    responses((status = 200, description = "All dependencies reachable"), (status = 503, description = "Degraded")))]
pub async fn health(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    let db = sqlx::query("SELECT 1").execute(&state.db).await.is_ok();
    let mut conn = state.redis.clone();
    let pong: redis::RedisResult<String> = redis::cmd("PING").query_async(&mut conn).await;
    let redis_ok = pong.is_ok();
    let ok = db && redis_ok;
    (
        if ok {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({
            "status": if ok { "ok" } else { "degraded" },
            "database": db,
            "redis": redis_ok,
            "version": env!("CARGO_PKG_VERSION"),
        })),
    )
}
