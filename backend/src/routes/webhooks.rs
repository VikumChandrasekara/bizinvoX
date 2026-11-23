//! Stripe webhook receiver: signature-verified, idempotent (Redis marker per
//! event id + idempotent SQL), and order-independent (subscription state is
//! re-fetched from Stripe rather than trusted from possibly-stale events).

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use chrono::DateTime;
use serde_json::Value;
use uuid::Uuid;

use crate::{
    cache,
    error::{AppError, AppResult},
    models::Plan,
    routes::payments,
    state::AppState,
};

const IDEMPOTENCY_TTL: u64 = 24 * 3600;

#[utoipa::path(post, path = "/api/v1/webhooks/stripe", tag = "webhooks",
    request_body(content = String, description = "Raw Stripe event payload"),
    responses((status = 200), (status = 400, description = "Bad signature")))]
pub async fn stripe(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<StatusCode> {
    let signature = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::bad_request("Missing Stripe-Signature header."))?;
    state.stripe.verify_webhook(&body, signature)?;

    let event: Value =
        serde_json::from_slice(&body).map_err(|_| AppError::bad_request("Invalid JSON."))?;
    let event_id = event["id"]
        .as_str()
        .ok_or_else(|| AppError::bad_request("Event has no id."))?
        .to_owned();
    let key = format!("idempotency:stripe:{event_id}");

    // If Redis is down we still process: every handler below is idempotent.
    let claimed = cache::set_nx(&state.redis, &key, "processing", IDEMPOTENCY_TTL)
        .await
        .unwrap_or(true);
    if !claimed {
        return Ok(StatusCode::OK);
    }
    match handle_event(&state, &event).await {
        Ok(()) => {
            cache::set_str(&state.redis, &key, "done", IDEMPOTENCY_TTL).await;
            Ok(StatusCode::OK)
        }
        Err(err) => {
            // Release the marker so Stripe's retry can reprocess.
            cache::del(&state.redis, &[key]).await;
            Err(err)
        }
    }
}

async fn handle_event(state: &AppState, event: &Value) -> AppResult<()> {
    let kind = event["type"].as_str().unwrap_or_default();
    let obj = &event["data"]["object"];
    tracing::info!(
        event_type = kind,
        event_id = event["id"].as_str().unwrap_or(""),
        "stripe webhook"
    );
    match kind {
        "checkout.session.completed" | "checkout.session.async_payment_succeeded" => {
            on_checkout_completed(state, obj).await
        }
        "checkout.session.async_payment_failed" | "checkout.session.expired" => {
            if let Some(id) = obj["id"].as_str() {
                sqlx::query("UPDATE payments SET status = 'failed', updated_at = now() WHERE stripe_checkout_session_id = $1 AND status = 'pending'")
                    .bind(id)
                    .execute(&state.db)
                    .await?;
            }
            Ok(())
        }
        "customer.subscription.created"
        | "customer.subscription.updated"
        | "customer.subscription.deleted" => {
            let sub_id = obj["id"].as_str().unwrap_or_default();
            // Re-fetch: events can arrive out of order.
            let current = match state.stripe.retrieve_subscription(sub_id).await {
                Ok(v) => v,
                Err(_) => obj.clone(),
            };
            sync_subscription(state, &current).await
        }
        "invoice.paid" => record_subscription_payment(state, obj).await,
        "charge.refunded" => {
            if let Some(pi) = obj["payment_intent"].as_str() {
                let ids: Vec<Uuid> = sqlx::query_scalar(
                    "SELECT id FROM payments WHERE stripe_payment_intent_id = $1",
                )
                .bind(pi)
                .fetch_all(&state.db)
                .await?;
                for id in ids {
                    payments::mark_refunded(state, id).await?;
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

async fn on_checkout_completed(state: &AppState, session: &Value) -> AppResult<()> {
    match session["mode"].as_str() {
        Some("payment") if session["metadata"]["kind"].as_str() == Some("single_download") => {
            if session["payment_status"].as_str() == Some("paid") {
                let id = session["id"].as_str().unwrap_or_default();
                payments::mark_download_paid(state, id, session["payment_intent"].as_str()).await?;
            }
            Ok(())
        }
        Some("subscription") => {
            let (Some(customer), Some(sub_id)) = (
                session["customer"].as_str(),
                session["subscription"].as_str(),
            ) else {
                return Ok(());
            };
            if let Some(uid) = session["metadata"]["user_id"]
                .as_str()
                .and_then(|s| Uuid::parse_str(s).ok())
            {
                sqlx::query("UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, $1), updated_at = now() WHERE id = $2")
                    .bind(customer)
                    .bind(uid)
                    .execute(&state.db)
                    .await?;
            }
            let sub = state.stripe.retrieve_subscription(sub_id).await?;
            sync_subscription(state, &sub).await
        }
        _ => Ok(()),
    }
}

/// Map a Stripe subscription onto `users.plan`. `past_due` keeps Pro during
/// Stripe's retry (grace) period; it drops to Free once Stripe gives up.
/// Downgrades never delete templates or invoices.
async fn sync_subscription(state: &AppState, sub: &Value) -> AppResult<()> {
    let Some(customer) = sub["customer"].as_str() else {
        return Ok(());
    };
    let status = sub["status"].as_str().unwrap_or_default();
    let plan = if matches!(status, "active" | "trialing" | "past_due") {
        Plan::Pro
    } else {
        Plan::Free
    };
    // Newer API versions moved current_period_end onto subscription items.
    let period_end = sub["current_period_end"]
        .as_i64()
        .or_else(|| sub["items"]["data"][0]["current_period_end"].as_i64())
        .and_then(|t| DateTime::from_timestamp(t, 0));
    let meta_user = sub["metadata"]["user_id"]
        .as_str()
        .and_then(|s| Uuid::parse_str(s).ok());

    let updated = sqlx::query(
        "UPDATE users SET plan = $1,
                plan_renews_at = CASE WHEN $1 = 'pro'::user_plan THEN $2 ELSE NULL END,
                stripe_subscription_id = $3,
                stripe_customer_id = COALESCE(stripe_customer_id, $4),
                updated_at = now()
          WHERE stripe_customer_id = $4 OR ($5::uuid IS NOT NULL AND id = $5)",
    )
    .bind(plan)
    .bind(period_end)
    .bind(sub["id"].as_str())
    .bind(customer)
    .bind(meta_user)
    .execute(&state.db)
    .await?
    .rows_affected();
    tracing::info!(customer, status, ?plan, updated, "subscription synced");
    Ok(())
}

async fn record_subscription_payment(state: &AppState, invoice: &Value) -> AppResult<()> {
    let (Some(stripe_invoice), Some(customer)) =
        (invoice["id"].as_str(), invoice["customer"].as_str())
    else {
        return Ok(());
    };
    let amount = invoice["amount_paid"]
        .as_i64()
        .unwrap_or(0)
        .clamp(0, i32::MAX as i64) as i32;
    let currency = invoice["currency"]
        .as_str()
        .unwrap_or("usd")
        .to_ascii_uppercase();
    sqlx::query(
        "INSERT INTO payments (user_id, stripe_invoice_id, stripe_payment_intent_id, kind, amount_cents, currency, status)
         SELECT id, $1, $2, 'pro_subscription', $3, $4, 'succeeded' FROM users WHERE stripe_customer_id = $5
         ON CONFLICT (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL DO NOTHING",
    )
    .bind(stripe_invoice)
    .bind(invoice["payment_intent"].as_str())
    .bind(amount)
    .bind(currency)
    .bind(customer)
    .execute(&state.db)
    .await?;
    Ok(())
}
