//! Authentication: signup/login with Argon2id, short-lived JWT access tokens,
//! rotated refresh tokens with reuse detection, email verification and
//! password reset.

use axum::{extract::State, http::StatusCode, Json};
use axum_extra::extract::CookieJar;
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
use validator::Validate;

use crate::{
    cache, cookies,
    error::{AppError, AppResult, ValidJson},
    extract::{AuthUser, ClientMeta},
    mailer::action_email,
    models::{normalize_email, EmailTokenKind, UserDto, UserRow, USER_COLS},
    security,
    state::AppState,
};

/// Window in which presenting an already-rotated refresh token is treated as
/// a benign race between two tabs rather than token theft.
const REFRESH_RACE_GRACE_SECS: i64 = 15;

#[derive(Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SignupRequest {
    #[validate(email, length(max = 254))]
    pub email: String,
    #[validate(length(min = 10, max = 128, message = "Password must be 10-128 characters."))]
    pub password: String,
}

#[derive(Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LoginRequest {
    #[validate(length(min = 3, max = 254))]
    pub email: String,
    #[validate(length(min = 1, max = 128))]
    pub password: String,
}

#[derive(Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PasswordResetRequest {
    #[validate(email, length(max = 254))]
    pub email: String,
}

#[derive(Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PasswordResetConfirm {
    #[validate(length(min = 20, max = 200))]
    pub token: String,
    #[validate(length(min = 10, max = 128, message = "Password must be 10-128 characters."))]
    pub password: String,
}

#[derive(Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct VerifyEmailRequest {
    #[validate(length(min = 20, max = 200))]
    pub token: String,
}

#[derive(Serialize, ToSchema)]
pub struct CsrfResponse {
    pub token: String,
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

async fn issue_session(
    state: &AppState,
    user_id: Uuid,
    meta: &ClientMeta,
    jar: CookieJar,
) -> AppResult<CookieJar> {
    let cfg = &state.config;
    let session_id = Uuid::new_v4();
    let refresh = security::random_token();
    let expires_at = Utc::now() + Duration::seconds(cfg.refresh_ttl_secs);
    sqlx::query(
        "INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, user_agent, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(security::sha256_hex(&refresh))
    .bind(expires_at)
    .bind(meta.user_agent.as_deref())
    .bind(security::hash_ip(&cfg.token_secret, &meta.ip.to_string()))
    .execute(&state.db)
    .await?;
    cache::set_str(
        &state.redis,
        &format!("session:{session_id}"),
        &user_id.to_string(),
        cfg.refresh_ttl_secs as u64,
    )
    .await;
    let access =
        security::issue_access_token(&cfg.jwt_secret, user_id, session_id, cfg.access_ttl_secs)?;
    Ok(jar
        .add(cookies::access(cfg, access))
        .add(cookies::refresh(cfg, refresh)))
}

async fn revoke_session(state: &AppState, session_id: Uuid) -> AppResult<()> {
    sqlx::query("DELETE FROM sessions WHERE id = $1")
        .bind(session_id)
        .execute(&state.db)
        .await?;
    cache::del(&state.redis, &[format!("session:{session_id}")]).await;
    Ok(())
}

pub async fn revoke_all_sessions(state: &AppState, user_id: Uuid) -> AppResult<()> {
    let ids: Vec<Uuid> = sqlx::query_scalar("DELETE FROM sessions WHERE user_id = $1 RETURNING id")
        .bind(user_id)
        .fetch_all(&state.db)
        .await?;
    let keys: Vec<String> = ids.iter().map(|id| format!("session:{id}")).collect();
    cache::del(&state.redis, &keys).await;
    Ok(())
}

fn clear_auth_cookies(jar: CookieJar) -> CookieJar {
    jar.remove(cookies::removal(cookies::ACCESS, "/"))
        .remove(cookies::removal(cookies::REFRESH, cookies::REFRESH_PATH))
}

/// A guest who signs up / logs in keeps the invoices they just built.
async fn claim_guest_invoices(
    state: &AppState,
    user_id: Uuid,
    jar: CookieJar,
) -> AppResult<CookieJar> {
    let guest = jar
        .get(cookies::GUEST)
        .and_then(|c| security::verify_guest(&state.config.token_secret, c.value()));
    let Some(guest_id) = guest else {
        return Ok(jar);
    };
    let claimed = sqlx::query(
        "UPDATE invoices SET user_id = $1, guest_token = NULL, updated_at = now()
          WHERE guest_token = $2 AND user_id IS NULL",
    )
    .bind(user_id)
    .bind(guest_id.to_string())
    .execute(&state.db)
    .await?
    .rows_affected();
    tracing::info!(%user_id, claimed, "claimed guest invoices");
    Ok(jar.remove(cookies::removal(cookies::GUEST, "/")))
}

async fn create_email_token(
    state: &AppState,
    user_id: Uuid,
    kind: EmailTokenKind,
    ttl: Duration,
) -> AppResult<String> {
    // Only the newest link of each kind stays valid.
    sqlx::query("UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL")
        .bind(user_id)
        .bind(kind)
        .execute(&state.db)
        .await?;
    let token = security::random_token();
    sqlx::query(
        "INSERT INTO email_tokens (user_id, kind, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(user_id)
    .bind(kind)
    .bind(security::sha256_hex(&token))
    .bind(Utc::now() + ttl)
    .execute(&state.db)
    .await?;
    Ok(token)
}

async fn consume_email_token(
    state: &AppState,
    token: &str,
    kind: EmailTokenKind,
) -> AppResult<Uuid> {
    sqlx::query_scalar(
        "UPDATE email_tokens SET used_at = now()
          WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now()
          RETURNING user_id",
    )
    .bind(security::sha256_hex(token))
    .bind(kind)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::gone("invalid_token", "This link is invalid or has expired."))
}

async fn send_verification(state: &AppState, user: &UserRow) -> AppResult<()> {
    let token = create_email_token(
        state,
        user.id,
        EmailTokenKind::VerifyEmail,
        Duration::hours(48),
    )
    .await?;
    let link = format!("{}/?verify={token}", state.config.app_origin);
    state.mailer.send(action_email(
        &user.email,
        "Verify your email address",
        "Welcome to bizinvoX.com! Confirm your email address to secure your account.",
        "Verify email",
        &link,
    ));
    Ok(())
}

async fn load_user(state: &AppState, id: Uuid) -> AppResult<UserRow> {
    Ok(
        sqlx::query_as::<_, UserRow>(&format!("SELECT {USER_COLS} FROM users WHERE id = $1"))
            .bind(id)
            .fetch_one(&state.db)
            .await?,
    )
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Issue (or re-issue) the double-submit CSRF token.
#[utoipa::path(get, path = "/api/v1/auth/csrf", tag = "auth",
    responses((status = 200, body = CsrfResponse)))]
pub async fn csrf(
    State(state): State<AppState>,
    jar: CookieJar,
) -> (CookieJar, Json<CsrfResponse>) {
    let token = match jar.get(cookies::CSRF) {
        Some(c) if c.value().len() >= 32 => c.value().to_owned(),
        _ => security::random_token(),
    };
    let jar = jar.add(cookies::csrf(&state.config, token.clone()));
    (jar, Json(CsrfResponse { token }))
}

#[utoipa::path(post, path = "/api/v1/auth/signup", tag = "auth", request_body = SignupRequest,
    responses((status = 201, body = UserDto), (status = 409, description = "Email already registered")))]
pub async fn signup(
    State(state): State<AppState>,
    meta: ClientMeta,
    jar: CookieJar,
    ValidJson(req): ValidJson<SignupRequest>,
) -> AppResult<(StatusCode, CookieJar, Json<UserDto>)> {
    let email = normalize_email(&req.email);
    if req
        .password
        .to_lowercase()
        .contains(email.split('@').next().unwrap_or_default())
        && email.len() > 4
    {
        return Err(AppError::validation(
            "Password must not contain your email address.",
        ));
    }
    let hash = security::hash_password(req.password, state.config.argon2).await?;
    let user = match sqlx::query_as::<_, UserRow>(&format!(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING {USER_COLS}"
    ))
    .bind(&email)
    .bind(&hash)
    .fetch_one(&state.db)
    .await
    {
        Ok(user) => user,
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(AppError::conflict(
                "email_taken",
                "An account with this email already exists.",
            ));
        }
        Err(e) => return Err(e.into()),
    };
    send_verification(&state, &user).await?;
    let jar = claim_guest_invoices(&state, user.id, jar).await?;
    let jar = issue_session(&state, user.id, &meta, jar).await?;
    Ok((StatusCode::CREATED, jar, Json(UserDto::from(&user))))
}

#[derive(sqlx::FromRow)]
struct Credentials {
    id: Uuid,
    password_hash: String,
}

#[utoipa::path(post, path = "/api/v1/auth/login", tag = "auth", request_body = LoginRequest,
    responses((status = 200, body = UserDto), (status = 401, description = "Invalid credentials")))]
pub async fn login(
    State(state): State<AppState>,
    meta: ClientMeta,
    jar: CookieJar,
    ValidJson(req): ValidJson<LoginRequest>,
) -> AppResult<(CookieJar, Json<UserDto>)> {
    let email = normalize_email(&req.email);
    let creds =
        sqlx::query_as::<_, Credentials>("SELECT id, password_hash FROM users WHERE email = $1")
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;
    let ok = security::verify_password(
        req.password,
        creds.as_ref().map(|c| c.password_hash.clone()),
        state.config.argon2,
    )
    .await?;
    let user_id = match (ok, creds) {
        (true, Some(c)) => c.id,
        _ => return Err(AppError::invalid_credentials()),
    };
    let user = load_user(&state, user_id).await?;
    let jar = claim_guest_invoices(&state, user.id, jar).await?;
    let jar = issue_session(&state, user.id, &meta, jar).await?;
    Ok((jar, Json(UserDto::from(&user))))
}

#[utoipa::path(post, path = "/api/v1/auth/logout", tag = "auth", responses((status = 204)))]
pub async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<(StatusCode, CookieJar)> {
    if let Some(rt) = jar.get(cookies::REFRESH) {
        let session: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM sessions WHERE refresh_token_hash = $1")
                .bind(security::sha256_hex(rt.value()))
                .fetch_optional(&state.db)
                .await?;
        if let Some(id) = session {
            revoke_session(&state, id).await?;
        }
    }
    Ok((StatusCode::NO_CONTENT, clear_auth_cookies(jar)))
}

#[derive(sqlx::FromRow)]
struct SessionLookup {
    id: Uuid,
    user_id: Uuid,
    expired: bool,
}

/// Rotate the refresh token. Presenting a token that was already rotated
/// (outside a short race window) is treated as theft and kills the session.
#[utoipa::path(post, path = "/api/v1/auth/refresh", tag = "auth",
    responses((status = 200, body = UserDto), (status = 401, description = "Refresh token invalid or revoked")))]
pub async fn refresh(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<(CookieJar, Json<UserDto>)> {
    let cfg = state.config.clone();
    let presented = jar
        .get(cookies::REFRESH)
        .map(|c| c.value().to_owned())
        .ok_or_else(AppError::unauthorized)?;
    let old_hash = security::sha256_hex(&presented);

    let session = sqlx::query_as::<_, SessionLookup>(
        "SELECT id, user_id, expires_at <= now() AS expired FROM sessions WHERE refresh_token_hash = $1",
    )
    .bind(&old_hash)
    .fetch_optional(&state.db)
    .await?;

    let Some(session) = session else {
        let used_key = format!("rt_used:{old_hash}");
        if let Ok(Some(marker)) = cache::get_str(&state.redis, &used_key).await {
            if let Some((sid, ts)) = marker.split_once(':') {
                let age = Utc::now().timestamp() - ts.parse::<i64>().unwrap_or(0);
                if age > REFRESH_RACE_GRACE_SECS {
                    if let Ok(sid) = Uuid::parse_str(sid) {
                        tracing::warn!(session_id = %sid, "refresh token reuse detected; revoking session");
                        revoke_session(&state, sid).await?;
                    }
                }
            }
        }
        return Err(AppError::session_revoked());
    };
    if session.expired {
        revoke_session(&state, session.id).await?;
        return Err(AppError::session_revoked());
    }

    let new_refresh = security::random_token();
    let rotated = sqlx::query(
        "UPDATE sessions SET refresh_token_hash = $1, last_used_at = now()
          WHERE id = $2 AND refresh_token_hash = $3",
    )
    .bind(security::sha256_hex(&new_refresh))
    .bind(session.id)
    .bind(&old_hash)
    .execute(&state.db)
    .await?
    .rows_affected();
    if rotated != 1 {
        return Err(AppError::session_revoked());
    }
    cache::set_str(
        &state.redis,
        &format!("rt_used:{old_hash}"),
        &format!("{}:{}", session.id, Utc::now().timestamp()),
        cfg.refresh_ttl_secs as u64,
    )
    .await;

    let user = load_user(&state, session.user_id).await?;
    let access =
        security::issue_access_token(&cfg.jwt_secret, user.id, session.id, cfg.access_ttl_secs)?;
    let jar = jar
        .add(cookies::access(&cfg, access))
        .add(cookies::refresh(&cfg, new_refresh));
    Ok((jar, Json(UserDto::from(&user))))
}

#[utoipa::path(get, path = "/api/v1/auth/me", tag = "auth",
    responses((status = 200, body = UserDto), (status = 401)))]
pub async fn me(user: AuthUser) -> Json<UserDto> {
    Json(UserDto::from(&user.user))
}

#[utoipa::path(post, path = "/api/v1/auth/verify-email", tag = "auth", request_body = VerifyEmailRequest,
    responses((status = 204), (status = 410, description = "Invalid or expired link")))]
pub async fn verify_email(
    State(state): State<AppState>,
    ValidJson(req): ValidJson<VerifyEmailRequest>,
) -> AppResult<StatusCode> {
    let user_id = consume_email_token(&state, &req.token, EmailTokenKind::VerifyEmail).await?;
    sqlx::query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1")
        .bind(user_id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/v1/auth/verify-email/resend", tag = "auth", responses((status = 202)))]
pub async fn resend_verification(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<StatusCode> {
    if user.user.email_verified_at.is_none() {
        send_verification(&state, &user.user).await?;
    }
    Ok(StatusCode::ACCEPTED)
}

/// Always 202 so the endpoint can't be used to discover registered emails.
#[utoipa::path(post, path = "/api/v1/auth/password-reset/request", tag = "auth",
    request_body = PasswordResetRequest, responses((status = 202)))]
pub async fn password_reset_request(
    State(state): State<AppState>,
    ValidJson(req): ValidJson<PasswordResetRequest>,
) -> AppResult<StatusCode> {
    let email = normalize_email(&req.email);
    let user =
        sqlx::query_as::<_, UserRow>(&format!("SELECT {USER_COLS} FROM users WHERE email = $1"))
            .bind(&email)
            .fetch_optional(&state.db)
            .await?;
    if let Some(user) = user {
        let token = create_email_token(
            &state,
            user.id,
            EmailTokenKind::PasswordReset,
            Duration::minutes(30),
        )
        .await?;
        let link = format!("{}/?reset={token}", state.config.app_origin);
        state.mailer.send(action_email(
            &user.email,
            "Reset your password",
            "We received a request to reset your password. This link expires in 30 minutes.",
            "Choose a new password",
            &link,
        ));
    }
    Ok(StatusCode::ACCEPTED)
}

#[utoipa::path(post, path = "/api/v1/auth/password-reset/confirm", tag = "auth",
    request_body = PasswordResetConfirm, responses((status = 204), (status = 410)))]
pub async fn password_reset_confirm(
    State(state): State<AppState>,
    jar: CookieJar,
    ValidJson(req): ValidJson<PasswordResetConfirm>,
) -> AppResult<(StatusCode, CookieJar)> {
    let user_id = consume_email_token(&state, &req.token, EmailTokenKind::PasswordReset).await?;
    let hash = security::hash_password(req.password, state.config.argon2).await?;
    sqlx::query(
        "UPDATE users SET password_hash = $1, email_verified_at = COALESCE(email_verified_at, now()),
                          updated_at = now() WHERE id = $2",
    )
    .bind(&hash)
    .bind(user_id)
    .execute(&state.db)
    .await?;
    // A reset signs the account out everywhere.
    revoke_all_sessions(&state, user_id).await?;
    Ok((StatusCode::NO_CONTENT, clear_auth_cookies(jar)))
}
