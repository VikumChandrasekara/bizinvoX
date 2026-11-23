use std::sync::Arc;

use redis::aio::ConnectionManager;
use sqlx::PgPool;

use crate::{config::Config, mailer::Mailer, stripe::Stripe};

/// Shared application state. Cheap to clone: every field is a handle.
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    /// Multiplexed, auto-reconnecting Redis connection.
    pub redis: ConnectionManager,
    pub config: Arc<Config>,
    pub stripe: Arc<Stripe>,
    pub mailer: Mailer,
}
