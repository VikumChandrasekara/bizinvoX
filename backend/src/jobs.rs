//! Periodic maintenance. Every statement is idempotent, so running it on
//! several replicas at once is harmless.

use std::time::Duration;

use crate::state::AppState;

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            if let Err(err) = cleanup(&state).await {
                tracing::warn!(error = ?err, "maintenance job failed");
            }
        }
    });
}

async fn cleanup(state: &AppState) -> anyhow::Result<()> {
    let db = &state.db;
    // Guest drafts are session-scoped: drop unpaid ones after 48h ...
    let unpaid = sqlx::query(
        "DELETE FROM invoices i
          WHERE i.user_id IS NULL
            AND i.created_at < now() - interval '48 hours'
            AND NOT EXISTS (SELECT 1 FROM payments p
                             WHERE p.invoice_id = i.id AND p.status IN ('succeeded', 'refunded'))",
    )
    .execute(db)
    .await?
    .rows_affected();
    // ... and paid ones after 30 days (payment rows are kept for accounting).
    let paid = sqlx::query(
        "DELETE FROM invoices WHERE user_id IS NULL AND created_at < now() - interval '30 days'",
    )
    .execute(db)
    .await?
    .rows_affected();
    // The recycle bin keeps deleted invoices and saved templates for 30 days, then removes them for good.
    let bin_invoices = sqlx::query("DELETE FROM invoices WHERE deleted_at < now() - interval '30 days'")
        .execute(db)
        .await?
        .rows_affected();
    let bin_templates = sqlx::query("DELETE FROM templates WHERE deleted_at < now() - interval '30 days'")
        .execute(db)
        .await?
        .rows_affected();
    sqlx::query("DELETE FROM sessions WHERE expires_at < now()")
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM download_tokens WHERE expires_at < now() - interval '7 days'")
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM email_tokens WHERE expires_at < now() - interval '7 days'")
        .execute(db)
        .await?;
    sqlx::query(
        "UPDATE payments SET status = 'failed', updated_at = now()
          WHERE status = 'pending' AND created_at < now() - interval '2 days'",
    )
    .execute(db)
    .await?;
    tracing::info!(
        unpaid_guest_drafts = unpaid,
        expired_guest_invoices = paid,
        recycle_bin_invoices = bin_invoices,
        recycle_bin_templates = bin_templates,
        "maintenance complete"
    );
    Ok(())
}
