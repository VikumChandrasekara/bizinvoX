//! Runtime configuration, loaded once from environment variables.
//! Secrets are never logged: `Config` intentionally does not implement `Debug`.

use std::{env, net::SocketAddr, str::FromStr};

use anyhow::{bail, Context, Result};

use crate::security::Argon2Params;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AppEnv {
    Development,
    Staging,
    Production,
}

#[derive(Clone)]
pub struct Config {
    pub app_env: AppEnv,
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub db_max_connections: u32,
    pub run_migrations: bool,
    pub redis_url: String,
    /// HS256 signing key for access tokens.
    pub jwt_secret: Vec<u8>,
    /// HMAC key for guest tokens and IP hashing (kept separate from the JWT key).
    pub token_secret: Vec<u8>,
    /// Public origin of the web frontend, e.g. `https://app.example.com`.
    pub app_origin: String,
    pub allowed_origins: Vec<String>,
    pub cookie_secure: bool,
    pub trust_proxy: bool,
    pub access_ttl_secs: i64,
    pub refresh_ttl_secs: i64,
    pub argon2: Argon2Params,
    pub stripe_secret_key: Option<String>,
    pub stripe_webhook_secret: Option<String>,
    pub stripe_price_pro_monthly: Option<String>,
    pub stripe_price_pro_annual: Option<String>,
    pub resend_api_key: Option<String>,
    pub email_from: String,
    pub enable_docs: bool,
}

fn var(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn required(name: &str) -> Result<String> {
    var(name).with_context(|| format!("missing required environment variable {name}"))
}

fn parsed<T>(name: &str, default: T) -> Result<T>
where
    T: FromStr,
    T::Err: std::fmt::Display,
{
    match var(name) {
        Some(raw) => raw
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid value for {name}: {e}")),
        None => Ok(default),
    }
}

fn secret(name: &str) -> Result<Vec<u8>> {
    let value = required(name)?;
    if value.len() < 32 {
        bail!("{name} must be at least 32 characters long");
    }
    Ok(value.into_bytes())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let app_env = match var("APP_ENV").as_deref() {
            None | Some("development") => AppEnv::Development,
            Some("staging") => AppEnv::Staging,
            Some("production") => AppEnv::Production,
            Some(other) => {
                bail!("APP_ENV must be development, staging or production (got {other})")
            }
        };

        let app_origin = var("APP_ORIGIN")
            .unwrap_or_else(|| "http://localhost:3000".into())
            .trim_end_matches('/')
            .to_owned();
        let mut allowed_origins = vec![app_origin.clone()];
        if let Some(extra) = var("ALLOWED_ORIGINS") {
            allowed_origins.extend(
                extra
                    .split(',')
                    .map(|o| o.trim().trim_end_matches('/').to_owned())
                    .filter(|o| !o.is_empty()),
            );
        }

        let jwt_secret = secret("JWT_SECRET")?;
        let token_secret = secret("TOKEN_SECRET")?;
        if jwt_secret == token_secret {
            bail!("JWT_SECRET and TOKEN_SECRET must be different");
        }

        let config = Self {
            app_env,
            bind_addr: parsed("BIND_ADDR", SocketAddr::from(([0, 0, 0, 0], 8080)))?,
            database_url: required("DATABASE_URL")?,
            db_max_connections: parsed("DB_MAX_CONNECTIONS", 20)?,
            run_migrations: parsed("RUN_MIGRATIONS", true)?,
            redis_url: required("REDIS_URL")?,
            jwt_secret,
            token_secret,
            app_origin,
            allowed_origins,
            cookie_secure: parsed("COOKIE_SECURE", app_env != AppEnv::Development)?,
            trust_proxy: parsed("TRUST_PROXY", false)?,
            access_ttl_secs: parsed("ACCESS_TOKEN_TTL_SECS", 15 * 60)?,
            refresh_ttl_secs: parsed("REFRESH_TOKEN_TTL_SECS", 30 * 24 * 3600)?,
            argon2: Argon2Params {
                // OWASP baseline: m=19 MiB, t=2, p=1. Raise on capable hardware.
                m_cost_kib: parsed("ARGON2_MEMORY_KIB", 19 * 1024)?,
                t_cost: parsed("ARGON2_ITERATIONS", 2)?,
                p_cost: parsed("ARGON2_PARALLELISM", 1)?,
            },
            stripe_secret_key: var("STRIPE_SECRET_KEY"),
            stripe_webhook_secret: var("STRIPE_WEBHOOK_SECRET"),
            stripe_price_pro_monthly: var("STRIPE_PRICE_PRO_MONTHLY"),
            stripe_price_pro_annual: var("STRIPE_PRICE_PRO_ANNUAL"),
            resend_api_key: var("RESEND_API_KEY"),
            email_from: var("EMAIL_FROM")
                .unwrap_or_else(|| "bizinvoX.com <no-reply@localhost>".into()),
            enable_docs: parsed("ENABLE_API_DOCS", app_env != AppEnv::Production)?,
        };

        if config.argon2.m_cost_kib < 19 * 1024 || config.argon2.t_cost < 2 {
            bail!("Argon2 parameters below the OWASP minimum (19 MiB, 2 iterations)");
        }
        if config.app_env == AppEnv::Production && !config.cookie_secure {
            bail!("COOKIE_SECURE must be true in production");
        }
        Ok(config)
    }

    pub fn is_production(&self) -> bool {
        self.app_env == AppEnv::Production
    }
}
