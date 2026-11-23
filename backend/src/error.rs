//! One error type for the whole API. Every error renders as
//! `{ "error": { "code": "...", "message": "..." } }`.

use axum::{
    async_trait,
    extract::{FromRequest, Request},
    http::{header::RETRY_AFTER, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::de::DeserializeOwned;
use serde_json::json;
use validator::Validate;

#[derive(Debug)]
pub enum AppError {
    Api {
        status: StatusCode,
        code: &'static str,
        message: String,
    },
    RateLimited {
        retry_after_secs: u64,
    },
    /// A third-party provider (Stripe, email) failed. Details are logged, not returned.
    Upstream(String),
    /// Anything unexpected. Details are logged, not returned.
    Internal(anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self::Api {
            status,
            code,
            message: message.into(),
        }
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }
    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
            message,
        )
    }
    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Please sign in to continue.",
        )
    }
    pub fn token_expired() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "token_expired",
            "Your session has expired.",
        )
    }
    pub fn session_revoked() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "session_revoked",
            "Your session is no longer valid. Please sign in again.",
        )
    }
    pub fn invalid_credentials() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "Invalid email or password.",
        )
    }
    pub fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }
    pub fn pro_required() -> Self {
        Self::forbidden(
            "pro_required",
            "Upgrade to Pro to create and customize templates.",
        )
    }
    pub fn not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "The requested resource was not found.",
        )
    }
    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }
    pub fn payment_required(message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYMENT_REQUIRED, "payment_required", message)
    }
    pub fn gone(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::GONE, code, message)
    }
    pub fn unavailable(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, code, message)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message, retry_after) = match self {
            AppError::Api {
                status,
                code,
                message,
            } => (status, code, message, None),
            AppError::RateLimited { retry_after_secs } => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many requests. Please wait a moment and try again.".to_owned(),
                Some(retry_after_secs),
            ),
            AppError::Upstream(detail) => {
                tracing::error!(%detail, "upstream provider error");
                (
                    StatusCode::BAD_GATEWAY,
                    "upstream_error",
                    "A payment or email provider is temporarily unavailable. Please try again."
                        .to_owned(),
                    None,
                )
            }
            AppError::Internal(err) => {
                tracing::error!(error = ?err, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "An unexpected error occurred.".to_owned(),
                    None,
                )
            }
        };
        let mut response = (
            status,
            Json(json!({ "error": { "code": code, "message": message } })),
        )
            .into_response();
        if let Some(secs) = retry_after {
            response
                .headers_mut()
                .insert(RETRY_AFTER, HeaderValue::from(secs));
        }
        response
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        Self::Internal(err)
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        match err {
            sqlx::Error::RowNotFound => Self::not_found(),
            other => Self::Internal(other.into()),
        }
    }
}

impl From<redis::RedisError> for AppError {
    fn from(err: redis::RedisError) -> Self {
        Self::Internal(err.into())
    }
}

impl From<tokio::task::JoinError> for AppError {
    fn from(err: tokio::task::JoinError) -> Self {
        Self::Internal(err.into())
    }
}

impl From<validator::ValidationErrors> for AppError {
    fn from(err: validator::ValidationErrors) -> Self {
        Self::validation(err.to_string().replace('\n', "; "))
    }
}

/// JSON body extractor that (1) rejects malformed/unknown fields with our error
/// shape and (2) runs `validator` rules before the handler sees the value.
pub struct ValidJson<T>(pub T);

#[async_trait]
impl<S, T> FromRequest<S> for ValidJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned + Validate,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let Json(value) = Json::<T>::from_request(req, state)
            .await
            .map_err(|rejection| AppError::bad_request(rejection.body_text()))?;
        value.validate()?;
        Ok(Self(value))
    }
}
