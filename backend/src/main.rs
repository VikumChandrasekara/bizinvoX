//! bizinvoX.com - API server.

mod cache;
mod config;
mod cookies;
mod error;
mod extract;
mod invoice_calc;
mod jobs;
mod mailer;
mod middleware;
mod models;
mod openapi;
mod pdf;
mod routes;
mod security;
mod state;
mod stripe;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

use crate::{config::Config, mailer::Mailer, state::AppState, stripe::Stripe};

fn init_tracing(json: bool) {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("big_api=info,tower_http=info,sqlx=warn"));
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false);
    if json {
        builder.json().flatten_event(true).init();
    } else {
        builder.compact().init();
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received, draining connections");
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let config = Arc::new(Config::from_env()?);
    init_tracing(config.is_production());

    let db = PgPoolOptions::new()
        .max_connections(config.db_max_connections)
        .min_connections(2)
        .acquire_timeout(Duration::from_secs(3))
        .connect(&config.database_url)
        .await?;
    if config.run_migrations {
        // sqlx takes an advisory lock, so concurrent replicas are safe.
        sqlx::migrate!("./migrations").run(&db).await?;
    }

    let redis =
        redis::aio::ConnectionManager::new(redis::Client::open(config.redis_url.as_str())?).await?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("big-api/", env!("CARGO_PKG_VERSION")))
        .build()?;

    let state = AppState {
        db,
        redis,
        stripe: Arc::new(Stripe::new(
            http.clone(),
            config.stripe_secret_key.clone(),
            config.stripe_webhook_secret.clone(),
        )),
        mailer: Mailer::spawn(http, config.clone()),
        config: config.clone(),
    };

    security::warm_up(config.argon2);
    jobs::spawn(state.clone());

    let app = routes::router(state);
    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    tracing::info!(addr = %config.bind_addr, "listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}
