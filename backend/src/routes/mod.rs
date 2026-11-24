pub mod admin;
pub mod auth;
pub mod billing;
pub mod health;
pub mod invoices;
pub mod payments;
pub mod pricing;
pub mod templates;
pub mod webhooks;

use std::time::Duration;

use axum::{
    http::{header, HeaderName, HeaderValue, Method},
    middleware::{from_fn, from_fn_with_state},
    routing::{delete, get, post, put},
    Router,
};
use tower_http::{
    compression::CompressionLayer,
    cors::{AllowOrigin, CorsLayer},
    limit::RequestBodyLimitLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::{middleware as mw, openapi::ApiDoc, state::AppState};

const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        // auth
        .route("/auth/csrf", get(auth::csrf))
        .route("/auth/signup", post(auth::signup))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/refresh", post(auth::refresh))
        .route("/auth/me", get(auth::me))
        .route("/auth/verify-email", post(auth::verify_email))
        .route("/auth/verify-email/resend", post(auth::resend_verification))
        .route(
            "/auth/password-reset/request",
            post(auth::password_reset_request),
        )
        .route(
            "/auth/password-reset/confirm",
            post(auth::password_reset_confirm),
        )
        // pricing
        .route("/pricing", get(pricing::get_pricing))
        // templates
        .route("/templates", get(templates::list).post(templates::create))
        // recycle bin (registered before `/templates/:id`, which would otherwise read "trash" as an id)
        .route(
            "/templates/trash",
            get(templates::trash_list).delete(templates::empty_trash),
        )
        .route("/templates/:id/restore", post(templates::restore))
        .route("/templates/:id/permanent", delete(templates::purge))
        .route(
            "/templates/:id",
            get(templates::get_one)
                .put(templates::update)
                .delete(templates::delete),
        )
        .route("/templates/:id/duplicate", post(templates::duplicate))
        .route(
            "/templates/:id/logo",
            get(templates::get_logo)
                .put(templates::upload_logo)
                .delete(templates::delete_logo),
        )
        // invoices
        .route("/invoices", get(invoices::list).post(invoices::create))
        // recycle bin
        .route(
            "/invoices/trash",
            get(invoices::trash_list).delete(invoices::empty_trash),
        )
        .route("/invoices/:id/restore", post(invoices::restore))
        .route("/invoices/:id/permanent", delete(invoices::purge))
        .route(
            "/invoices/:id",
            get(invoices::get_one)
                .put(invoices::update)
                .delete(invoices::delete),
        )
        .route("/invoices/:id/duplicate", post(invoices::duplicate))
        .route(
            "/invoices/:id/logo",
            get(invoices::get_logo)
                .put(invoices::upload_logo)
                .delete(invoices::delete_logo),
        )
        .route(
            "/invoices/:id/render-preview",
            post(invoices::render_preview),
        )
        .route("/exports/invoices.csv", get(invoices::export_csv))
        // payments / download gate
        .route("/invoices/:id/checkout", post(payments::checkout))
        .route(
            "/invoices/:id/checkout/confirm",
            post(payments::confirm_checkout),
        )
        .route("/invoices/:id/download", post(payments::download))
        // billing
        .route("/billing/subscription", get(billing::subscription))
        .route("/billing/subscribe", post(billing::subscribe))
        .route("/billing/confirm", post(billing::confirm))
        .route("/billing/cancel", post(billing::cancel))
        .route("/billing/resume", post(billing::resume))
        .route("/billing/portal", post(billing::portal))
        // webhooks
        .route("/webhooks/stripe", post(webhooks::stripe))
        // admin
        .route("/admin/payments/:id/refund", post(admin::refund))
        .route("/admin/pricing", put(admin::update_pricing));

    let origins: Vec<HeaderValue> = state
        .config
        .allowed_origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(true)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([
            header::CONTENT_TYPE,
            HeaderName::from_static("x-csrf-token"),
        ])
        .max_age(Duration::from_secs(600));

    let mut app = Router::new()
        .route("/health", get(health::health))
        .nest("/api/v1", api);
    if state.config.enable_docs {
        app = app.merge(SwaggerUi::new("/docs").url("/api/v1/openapi.json", ApiDoc::openapi()));
    }

    let request_id = HeaderName::from_static("x-request-id");
    // Layers run outermost-last: request id -> trace -> timeout -> limits ->
    // compression -> CORS -> security headers -> rate limit -> CSRF -> handler.
    // Rate limiting sits outside CSRF so rejected/abusive requests still count.
    app.layer(from_fn_with_state(state.clone(), mw::csrf))
        .layer(from_fn_with_state(state.clone(), mw::rate_limit))
        .layer(from_fn(mw::security_headers))
        .layer(cors)
        .layer(CompressionLayer::new())
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES))
        .layer(TimeoutLayer::new(Duration::from_secs(20)))
        .layer(PropagateRequestIdLayer::new(request_id.clone()))
        .layer(TraceLayer::new_for_http())
        .layer(SetRequestIdLayer::new(request_id, MakeRequestUuid))
        .with_state(state)
}
