//! Cookie definitions. Auth cookies are HttpOnly + Secure (outside dev) + SameSite.

use axum_extra::extract::cookie::{Cookie, SameSite};

use crate::config::Config;

pub const ACCESS: &str = "big_at";
pub const REFRESH: &str = "big_rt";
pub const GUEST: &str = "big_guest";
pub const CSRF: &str = "big_csrf";

/// Refresh cookie is only ever sent to the auth endpoints.
pub const REFRESH_PATH: &str = "/api/v1/auth";

const GUEST_TTL_SECS: i64 = 2 * 24 * 3600;
const CSRF_TTL_SECS: i64 = 7 * 24 * 3600;

/// The cookie outlives the JWT inside it on purpose: an *expired* token makes
/// the API answer `token_expired` (so the client refreshes) instead of the
/// browser silently dropping the cookie and the user being treated as a guest.
pub fn access(cfg: &Config, value: String) -> Cookie<'static> {
    Cookie::build((ACCESS, value))
        .http_only(true)
        .secure(cfg.cookie_secure)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time::Duration::seconds(cfg.refresh_ttl_secs))
        .build()
}

pub fn refresh(cfg: &Config, value: String) -> Cookie<'static> {
    Cookie::build((REFRESH, value))
        .http_only(true)
        .secure(cfg.cookie_secure)
        .same_site(SameSite::Strict)
        .path(REFRESH_PATH)
        .max_age(time::Duration::seconds(cfg.refresh_ttl_secs))
        .build()
}

pub fn guest(cfg: &Config, value: String) -> Cookie<'static> {
    Cookie::build((GUEST, value))
        .http_only(true)
        .secure(cfg.cookie_secure)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time::Duration::seconds(GUEST_TTL_SECS))
        .build()
}

/// Double-submit CSRF cookie: readable by the frontend's JS on purpose.
pub fn csrf(cfg: &Config, value: String) -> Cookie<'static> {
    Cookie::build((CSRF, value))
        .http_only(false)
        .secure(cfg.cookie_secure)
        .same_site(SameSite::Strict)
        .path("/")
        .max_age(time::Duration::seconds(CSRF_TTL_SECS))
        .build()
}

pub fn removal(name: &'static str, path: &'static str) -> Cookie<'static> {
    Cookie::build((name, "")).path(path).build()
}
