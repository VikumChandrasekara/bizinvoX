//! Cross-cutting HTTP middleware: security headers, CSRF and rate limiting.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderValue, Method},
    middleware::Next,
    response::{IntoResponse, Response},
};
use axum_extra::extract::CookieJar;

use crate::{cache, cookies, error::AppError, extract::client_ip, security, state::AppState};

const API_CSP: &str = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
const DOCS_CSP: &str = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'";

pub async fn security_headers(req: Request, next: Next) -> Response {
    let is_docs = req.uri().path().starts_with("/docs");
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(if is_docs { DOCS_CSP } else { API_CSP }),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        header::STRICT_TRANSPORT_SECURITY,
        HeaderValue::from_static("max-age=63072000; includeSubDomains; preload"),
    );
    h.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-site"),
    );
    h.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    res
}

fn is_mutating(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

/// Double-submit-cookie CSRF protection plus an Origin allow-list check for
/// every state-changing API request. Stripe webhooks are exempt (they are
/// authenticated by signature instead).
pub async fn csrf(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if is_mutating(req.method())
        && path.starts_with("/api/")
        && !path.starts_with("/api/v1/webhooks/")
    {
        if let Some(origin) = req
            .headers()
            .get(header::ORIGIN)
            .and_then(|o| o.to_str().ok())
        {
            let origin = origin.trim_end_matches('/');
            if !state.config.allowed_origins.iter().any(|o| o == origin) {
                return AppError::forbidden("origin_rejected", "Request origin is not allowed.")
                    .into_response();
            }
        }
        let jar = CookieJar::from_headers(req.headers());
        let cookie = jar.get(cookies::CSRF).map(|c| c.value().to_owned());
        let header_token = req
            .headers()
            .get("x-csrf-token")
            .and_then(|v| v.to_str().ok());
        let valid = matches!((cookie.as_deref(), header_token),
            (Some(c), Some(h)) if c.len() >= 32 && security::constant_time_eq(c, h));
        if !valid {
            return AppError::forbidden(
                "csrf_failed",
                "Missing or invalid CSRF token. Refresh the page and try again.",
            )
            .into_response();
        }
    }
    next.run(req).await
}

/// (bucket name, requests per minute) for a route, or `None` to skip limiting.
fn classify(method: &Method, path: &str) -> Option<(&'static str, u32)> {
    if !path.starts_with("/api/") || path.starts_with("/api/v1/webhooks/") {
        return None;
    }
    let post = *method == Method::POST;
    Some(match path {
        "/api/v1/auth/login" | "/api/v1/auth/signup" if post => ("auth", 10),
        p if post
            && (p.starts_with("/api/v1/auth/password-reset")
                || p.starts_with("/api/v1/auth/verify-email")) =>
        {
            ("auth_email", 5)
        }
        "/api/v1/auth/refresh" if post => ("refresh", 30),
        "/api/v1/invoices" if post => ("invoice_create", 30),
        p if post && p.ends_with("/render-preview") => ("preview", 40),
        p if post && (p.ends_with("/checkout") || p.ends_with("/subscribe")) => ("checkout", 10),
        p if post && p.ends_with("/download") => ("download", 20),
        _ => ("api", 300),
    })
}

pub async fn rate_limit(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let Some((bucket, limit)) = classify(req.method(), req.uri().path()) else {
        return next.run(req).await;
    };
    let ip = client_ip(
        req.headers(),
        req.extensions().get::<ConnectInfo<SocketAddr>>(),
        state.config.trust_proxy,
    );
    let key = format!("rate_limit:{ip}:{bucket}");
    match cache::rate_limit_allow(&state.redis, &key, limit, 60_000).await {
        Ok(true) => next.run(req).await,
        Ok(false) => AppError::RateLimited {
            retry_after_secs: 60,
        }
        .into_response(),
        Err(err) => {
            // Fail open so a Redis blip doesn't take the API down; Argon2 cost
            // still makes credential stuffing expensive.
            tracing::warn!(error = %err, "rate limiter unavailable");
            next.run(req).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_sensitive_routes() {
        assert_eq!(
            classify(&Method::POST, "/api/v1/auth/login"),
            Some(("auth", 10))
        );
        assert_eq!(
            classify(&Method::POST, "/api/v1/invoices"),
            Some(("invoice_create", 30))
        );
        assert_eq!(
            classify(&Method::GET, "/api/v1/invoices"),
            Some(("api", 300))
        );
        assert_eq!(classify(&Method::POST, "/api/v1/webhooks/stripe"), None);
        assert_eq!(classify(&Method::GET, "/health"), None);
    }
}
