//! Request extractors: authenticated user, optional user, guest/user requester,
//! and client metadata.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::{
    async_trait,
    extract::{ConnectInfo, FromRequestParts},
    http::{header, request::Parts, HeaderMap},
};
use axum_extra::extract::CookieJar;
use uuid::Uuid;

use crate::{
    cache, cookies,
    error::AppError,
    models::{Plan, UserRow, USER_COLS},
    security,
    state::AppState,
};

/// A signed-in user. Rejects with 401 when absent or invalid.
pub struct AuthUser {
    pub user: UserRow,
    /// Session backing this request (available for audit logging / per-session revocation).
    #[allow(dead_code)]
    pub session_id: Uuid,
}

impl AuthUser {
    pub fn id(&self) -> Uuid {
        self.user.id
    }
    pub fn is_pro(&self) -> bool {
        self.user.plan == Plan::Pro
    }
}

/// Signed-in user if present. A *present but invalid/expired* token is still
/// rejected with 401 so the client refreshes instead of silently being
/// treated as a guest.
pub struct MaybeUser(pub Option<AuthUser>);

/// Who is making an invoice request.
pub enum Requester {
    User(AuthUser),
    Guest(Uuid),
    Anonymous,
}

impl Requester {
    pub fn user(&self) -> Option<&AuthUser> {
        match self {
            Requester::User(u) => Some(u),
            _ => None,
        }
    }
    pub fn user_id(&self) -> Option<Uuid> {
        self.user().map(AuthUser::id)
    }
    pub fn guest_id(&self) -> Option<Uuid> {
        match self {
            Requester::Guest(id) => Some(*id),
            _ => None,
        }
    }
    /// Plan checks always come from the database row loaded for this request.
    pub fn is_pro(&self) -> bool {
        self.user().is_some_and(AuthUser::is_pro)
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(|t| t.trim().to_owned())
}

async fn ensure_session_active(state: &AppState, sid: Uuid, user_id: Uuid) -> Result<(), AppError> {
    let key = format!("session:{sid}");
    if let Ok(Some(cached_uid)) = cache::get_str(&state.redis, &key).await {
        if cached_uid == user_id.to_string() {
            return Ok(());
        }
    }
    // Cache miss (or Redis outage): Postgres is authoritative.
    let remaining: Option<i64> = sqlx::query_scalar(
        "SELECT EXTRACT(EPOCH FROM (expires_at - now()))::bigint
           FROM sessions WHERE id = $1 AND user_id = $2 AND expires_at > now()",
    )
    .bind(sid)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    match remaining {
        Some(secs) if secs > 0 => {
            cache::set_str(&state.redis, &key, &user_id.to_string(), secs as u64).await;
            Ok(())
        }
        _ => Err(AppError::session_revoked()),
    }
}

async fn authenticate(parts: &Parts, state: &AppState) -> Result<Option<AuthUser>, AppError> {
    let jar = CookieJar::from_headers(&parts.headers);
    let token = bearer_token(&parts.headers)
        .or_else(|| jar.get(cookies::ACCESS).map(|c| c.value().to_owned()));
    let Some(token) = token.filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let claims = security::decode_access_token(&state.config.jwt_secret, &token)
        .ok_or_else(AppError::token_expired)?;
    ensure_session_active(state, claims.sid, claims.sub).await?;
    let user =
        sqlx::query_as::<_, UserRow>(&format!("SELECT {USER_COLS} FROM users WHERE id = $1"))
            .bind(claims.sub)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(AppError::session_revoked)?;
    Ok(Some(AuthUser {
        user,
        session_id: claims.sid,
    }))
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        authenticate(parts, state)
            .await?
            .ok_or_else(AppError::unauthorized)
    }
}

#[async_trait]
impl FromRequestParts<AppState> for MaybeUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(MaybeUser(authenticate(parts, state).await?))
    }
}

#[async_trait]
impl FromRequestParts<AppState> for Requester {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if let Some(user) = authenticate(parts, state).await? {
            return Ok(Requester::User(user));
        }
        let jar = CookieJar::from_headers(&parts.headers);
        let guest = jar
            .get(cookies::GUEST)
            .and_then(|c| security::verify_guest(&state.config.token_secret, c.value()));
        Ok(guest.map_or(Requester::Anonymous, Requester::Guest))
    }
}

/// Client IP + user agent (used for rate limiting and session metadata).
pub struct ClientMeta {
    pub ip: IpAddr,
    pub user_agent: Option<String>,
}

pub fn client_ip(
    headers: &HeaderMap,
    connect: Option<&ConnectInfo<SocketAddr>>,
    trust_proxy: bool,
) -> IpAddr {
    if trust_proxy {
        // Only honoured when the deployment guarantees a trusted proxy
        // (load balancer / Next.js server) overwrites this header.
        let forwarded = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.trim().parse().ok());
        if let Some(ip) = forwarded {
            return ip;
        }
    }
    connect
        .map(|c| c.0.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
}

#[async_trait]
impl FromRequestParts<AppState> for ClientMeta {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let ip = client_ip(
            &parts.headers,
            parts.extensions.get::<ConnectInfo<SocketAddr>>(),
            state.config.trust_proxy,
        );
        let user_agent = parts
            .headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .map(|ua| ua.chars().take(300).collect());
        Ok(ClientMeta { ip, user_agent })
    }
}
