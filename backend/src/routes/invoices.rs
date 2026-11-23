//! Invoices: create/read/update/delete for guests (signed guest cookie) and
//! users, cursor pagination, previews and CSV export.

use axum::{
    extract::{Multipart, Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use axum_extra::extract::CookieJar;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;
use validator::Validate;

use crate::{
    cookies,
    error::{AppError, AppResult, ValidJson},
    extract::{AuthUser, Requester},
    invoice_calc::{self, LineItem, Totals},
    models::{InvoiceDto, InvoiceRow, InvoiceStatus, Party, TemplateLayout, INVOICE_COLS},
    pdf,
    routes::templates::{self, DEFAULT_TEMPLATE_ID},
    security,
    state::AppState,
};

const MAX_GUEST_INVOICES: i64 = 50;

#[derive(Debug, Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InvoiceInput {
    /// Omit for the default template. Custom templates require Pro.
    pub template_id: Option<Uuid>,
    /// Omit to auto-number.
    #[validate(length(min = 1, max = 40))]
    pub invoice_number: Option<String>,
    pub issue_date: NaiveDate,
    pub due_date: Option<NaiveDate>,
    #[validate(length(equal = 3))]
    pub currency: String,
    #[validate(nested)]
    pub business: Party,
    #[validate(nested)]
    pub client: Party,
    #[validate(length(min = 1, max = 100), nested)]
    pub line_items: Vec<LineItem>,
    #[validate(length(max = 2000))]
    pub notes: Option<String>,
    #[validate(length(max = 300))]
    pub payment_terms: Option<String>,
    /// Guest/Free customizations of the Classic template (colors, fonts, removed fields).
    /// Ignored for Pro accounts, whose look comes from `template_id`.
    #[validate(nested)]
    pub layout: Option<TemplateLayout>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListQuery {
    /// 1-100, default 20.
    pub limit: Option<i64>,
    /// Opaque cursor from a previous page's `nextCursor`.
    pub cursor: Option<String>,
    /// Pro only: search invoice number / client name.
    pub q: Option<String>,
    /// Pro only: filter by status.
    pub status: Option<InvoiceStatus>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvoicePage {
    pub items: Vec<InvoiceDto>,
    pub next_cursor: Option<String>,
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

fn validate_input(input: &InvoiceInput) -> AppResult<(String, Totals)> {
    let currency = input.currency.trim().to_ascii_uppercase();
    if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(AppError::validation(
            "Currency must be a 3-letter ISO 4217 code.",
        ));
    }
    if let Some(due) = input.due_date {
        if due < input.issue_date {
            return Err(AppError::validation(
                "Due date can't be before the issue date.",
            ));
        }
    }
    Ok((currency, invoice_calc::compute(&input.line_items)?))
}

async fn next_invoice_number(state: &AppState, requester: &Requester) -> AppResult<String> {
    match requester.user_id() {
        Some(uid) => {
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invoices WHERE user_id = $1")
                .bind(uid)
                .fetch_one(&state.db)
                .await?;
            Ok(format!("INV-{:04}", count + 1))
        }
        None => Ok(format!(
            "INV-{}-{}",
            Utc::now().format("%Y%m%d"),
            Uuid::new_v4().simple().to_string()[..4].to_uppercase()
        )),
    }
}

/// Load an invoice only if the requester owns it (user id or guest token).
/// Non-owners get 404 so ids can't be probed.
pub async fn load_owned(
    state: &AppState,
    requester: &Requester,
    id: Uuid,
) -> AppResult<InvoiceRow> {
    load_scoped(state, requester, id, false).await
}

/// An invoice of the requester's that is in the recycle bin (restore / delete forever only).
async fn load_trashed(
    state: &AppState,
    requester: &Requester,
    id: Uuid,
) -> AppResult<InvoiceRow> {
    load_scoped(state, requester, id, true).await
}

/// Invoices in the recycle bin are invisible to everything else, so every normal read goes through `trashed = false`.
async fn load_scoped(
    state: &AppState,
    requester: &Requester,
    id: Uuid,
    trashed: bool,
) -> AppResult<InvoiceRow> {
    let user_id = requester.user_id();
    let guest = requester.guest_id().map(|g| g.to_string());
    if user_id.is_none() && guest.is_none() {
        return Err(AppError::not_found());
    }
    sqlx::query_as::<_, InvoiceRow>(&format!(
        "SELECT {INVOICE_COLS} FROM invoices
          WHERE id = $1 AND (user_id = $2 OR guest_token = $3) AND (deleted_at IS NOT NULL) = $4"
    ))
    .bind(id)
    .bind(user_id)
    .bind(guest)
    .bind(trashed)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(AppError::not_found)
}

/// Logo stored on the invoice itself (Guest/Free).
async fn invoice_logo(state: &AppState, id: Uuid) -> AppResult<Option<Vec<u8>>> {
    let row: Option<Option<Vec<u8>>> =
        sqlx::query_scalar("SELECT logo_png FROM invoices WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    Ok(row.flatten())
}

/// True when the PDF for this invoice carries no watermark: Pro accounts always,
/// everyone else once the watermark has been paid off for this invoice.
pub async fn is_watermark_free(
    state: &AppState,
    requester: &Requester,
    invoice_id: Uuid,
) -> AppResult<bool> {
    if requester.is_pro() {
        return Ok(true);
    }
    let paid: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM payments
                         WHERE invoice_id = $1 AND kind = 'single_download' AND status = 'succeeded')",
    )
    .bind(invoice_id)
    .fetch_one(&state.db)
    .await?;
    Ok(paid)
}

/// Render to PDF on the blocking pool.
///
/// Pro accounts use the invoice's template. Everyone else gets the Classic look as
/// customized on the invoice itself (layout + logo), the branding footer, and a
/// tiled "bizinvoX.com" watermark unless `watermark` is false.
pub async fn render_pdf(
    state: &AppState,
    inv: &InvoiceRow,
    is_pro: bool,
    watermark: bool,
) -> AppResult<Vec<u8>> {
    let (layout, logo) = if is_pro {
        templates::layout_for_render(state, inv.template_id).await?
    } else {
        let (default_layout, _) = templates::layout_for_render(state, DEFAULT_TEMPLATE_ID).await?;
        let layout = inv
            .layout_json
            .as_ref()
            .map(|j| j.0.clone())
            .unwrap_or(default_layout)
            // Older saves may have fields or columns removed; that is Pro only.
            .without_removals();
        let logo = if inv.has_logo {
            invoice_logo(state, inv.id).await?
        } else {
            None
        };
        (layout, logo)
    };
    let inv = inv.clone();
    let opts = pdf::RenderOptions {
        branding_footer: !is_pro,
        watermark: watermark && !is_pro,
    };
    let started = std::time::Instant::now();
    let bytes =
        tokio::task::spawn_blocking(move || pdf::render(&inv, &layout, logo.as_deref(), &opts))
            .await??;
    tracing::debug!(
        elapsed_ms = started.elapsed().as_millis() as u64,
        size = bytes.len(),
        "rendered pdf"
    );
    Ok(bytes)
}

pub fn pdf_response(bytes: Vec<u8>, invoice_number: &str, inline: bool) -> Response {
    let safe: String = invoice_number
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(60)
        .collect();
    let disposition = format!(
        "{}; filename=\"invoice-{}.pdf\"",
        if inline { "inline" } else { "attachment" },
        if safe.is_empty() { "download" } else { &safe }
    );
    (
        [
            (header::CONTENT_TYPE, "application/pdf".to_owned()),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CACHE_CONTROL, "no-store".to_owned()),
        ],
        bytes,
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[utoipa::path(post, path = "/api/v1/invoices", tag = "invoices", request_body = InvoiceInput,
    responses((status = 201, body = InvoiceDto), (status = 403, description = "Custom template requires Pro"), (status = 422)))]
pub async fn create(
    State(state): State<AppState>,
    requester: Requester,
    jar: CookieJar,
    ValidJson(input): ValidJson<InvoiceInput>,
) -> AppResult<(StatusCode, CookieJar, Json<InvoiceDto>)> {
    // First invoice from an anonymous visitor mints a signed guest session.
    let (requester, jar) = match requester {
        Requester::Anonymous => {
            let guest_id = Uuid::new_v4();
            let token = security::sign_guest(&state.config.token_secret, guest_id);
            (
                Requester::Guest(guest_id),
                jar.add(cookies::guest(&state.config, token)),
            )
        }
        other => (other, jar),
    };

    if let Some(guest_id) = requester.guest_id() {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invoices WHERE guest_token = $1")
            .bind(guest_id.to_string())
            .fetch_one(&state.db)
            .await?;
        if count >= MAX_GUEST_INVOICES {
            return Err(AppError::conflict(
                "guest_limit",
                "Create a free account to keep making invoices.",
            ));
        }
    }

    let template_id = templates::resolve_template_id(&state, &requester, input.template_id).await?;
    let (currency, totals) = validate_input(&input)?;
    let number = match clean(input.invoice_number.clone()) {
        Some(n) => n,
        None => next_invoice_number(&state, &requester).await?,
    };
    // Pro looks come from templates; Guest/Free customizations live on the invoice.
    let layout_json = if requester.is_pro() {
        None
    } else {
        input
            .layout
            .clone()
            .map(|l| sqlx::types::Json(l.without_removals()))
    };

    let row = sqlx::query_as::<_, InvoiceRow>(&format!(
        "INSERT INTO invoices (user_id, guest_token, template_id, invoice_number, issue_date, due_date, currency,
                               business_info, client_info, line_items, subtotal, tax_total, discount_total,
                               grand_total, notes, payment_terms, layout_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING {INVOICE_COLS}"
    ))
    .bind(requester.user_id())
    .bind(requester.guest_id().map(|g| g.to_string()))
    .bind(template_id)
    .bind(&number)
    .bind(input.issue_date)
    .bind(input.due_date)
    .bind(&currency)
    .bind(sqlx::types::Json(&input.business))
    .bind(sqlx::types::Json(&input.client))
    .bind(sqlx::types::Json(&input.line_items))
    .bind(totals.subtotal)
    .bind(totals.tax_total)
    .bind(totals.discount_total)
    .bind(totals.grand_total)
    .bind(clean(input.notes))
    .bind(clean(input.payment_terms))
    .bind(layout_json)
    .fetch_one(&state.db)
    .await?;

    let is_pro = requester.is_pro();
    Ok((
        StatusCode::CREATED,
        jar,
        Json(InvoiceDto::from_row(row, is_pro)),
    ))
}

fn encode_cursor(created_at: DateTime<Utc>, id: Uuid) -> String {
    URL_SAFE_NO_PAD.encode(format!("{}|{id}", created_at.to_rfc3339()))
}

fn decode_cursor(cursor: &str) -> AppResult<(DateTime<Utc>, Uuid)> {
    let invalid = || AppError::bad_request("Invalid cursor.");
    let raw = String::from_utf8(URL_SAFE_NO_PAD.decode(cursor).map_err(|_| invalid())?)
        .map_err(|_| invalid())?;
    let (ts, id) = raw.split_once('|').ok_or_else(invalid)?;
    Ok((
        DateTime::parse_from_rfc3339(ts)
            .map_err(|_| invalid())?
            .with_timezone(&Utc),
        Uuid::parse_str(id).map_err(|_| invalid())?,
    ))
}

#[utoipa::path(get, path = "/api/v1/invoices", tag = "invoices", params(ListQuery),
    responses((status = 200, body = InvoicePage), (status = 401), (status = 403, description = "Search/filter requires Pro")))]
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<InvoicePage>> {
    let search = clean(q.q);
    if (search.is_some() || q.status.is_some()) && !user.is_pro() {
        return Err(AppError::forbidden(
            "pro_required",
            "Search and filters are available on Pro.",
        ));
    }
    let limit = q.limit.unwrap_or(20).clamp(1, 100);
    let cursor = q.cursor.as_deref().map(decode_cursor).transpose()?;
    let pattern = search.map(|s| {
        let escaped = s
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        format!("%{escaped}%")
    });

    let mut rows = sqlx::query_as::<_, InvoiceRow>(&format!(
        "SELECT {INVOICE_COLS} FROM invoices
          WHERE user_id = $1 AND deleted_at IS NULL
            AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3))
            AND ($4::invoice_status IS NULL OR status = $4)
            AND ($5::text IS NULL OR invoice_number ILIKE $5 OR client_info->>'name' ILIKE $5)
          ORDER BY created_at DESC, id DESC
          LIMIT $6"
    ))
    .bind(user.id())
    .bind(cursor.map(|c| c.0))
    .bind(cursor.map(|c| c.1))
    .bind(q.status)
    .bind(pattern)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;

    let next_cursor = if rows.len() as i64 > limit {
        rows.truncate(limit as usize);
        rows.last().map(|r| encode_cursor(r.created_at, r.id))
    } else {
        None
    };
    let pro = user.is_pro();
    Ok(Json(InvoicePage {
        items: rows
            .into_iter()
            .map(|r| InvoiceDto::from_row(r, pro))
            .collect(),
        next_cursor,
    }))
}

#[utoipa::path(get, path = "/api/v1/invoices/{id}", tag = "invoices",
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 200, body = InvoiceDto), (status = 404)))]
pub async fn get_one(
    State(state): State<AppState>,
    requester: Requester,
    Path(id): Path<Uuid>,
) -> AppResult<Json<InvoiceDto>> {
    let row = load_owned(&state, &requester, id).await?;
    Ok(Json(InvoiceDto::from_row(row, requester.is_pro())))
}

#[utoipa::path(put, path = "/api/v1/invoices/{id}", tag = "invoices", request_body = InvoiceInput,
    params(("id" = Uuid, Path, description = "Resource id")),
    responses((status = 200, body = InvoiceDto), (status = 404), (status = 409, description = "Paid non-Pro invoices are locked")))]
pub async fn update(
    State(state): State<AppState>,
    requester: Requester,
    Path(id): Path<Uuid>,
    ValidJson(input): ValidJson<InvoiceInput>,
) -> AppResult<Json<InvoiceDto>> {
    let existing = load_owned(&state, &requester, id).await?;
    let is_pro = requester.is_pro();
    if !is_pro && existing.status != InvoiceStatus::Draft {
        return Err(AppError::conflict(
            "invoice_locked",
            "This invoice has been paid for and can't be edited. Duplicate it to make changes.",
        ));
    }
    let template_id = templates::resolve_template_id(&state, &requester, input.template_id).await?;
    let (currency, totals) = validate_input(&input)?;
    let number = clean(input.invoice_number.clone()).unwrap_or(existing.invoice_number);
    let layout_json = if is_pro {
        None
    } else {
        input
            .layout
            .clone()
            .map(|l| sqlx::types::Json(l.without_removals()))
    };

    let row = sqlx::query_as::<_, InvoiceRow>(&format!(
        "UPDATE invoices SET template_id = $2, invoice_number = $3, issue_date = $4, due_date = $5, currency = $6,
                business_info = $7, client_info = $8, line_items = $9, subtotal = $10, tax_total = $11,
                discount_total = $12, grand_total = $13, notes = $14, payment_terms = $15,
                layout_json = COALESCE($16, layout_json), updated_at = now()
          WHERE id = $1
          RETURNING {INVOICE_COLS}"
    ))
    .bind(id)
    .bind(template_id)
    .bind(&number)
    .bind(input.issue_date)
    .bind(input.due_date)
    .bind(&currency)
    .bind(sqlx::types::Json(&input.business))
    .bind(sqlx::types::Json(&input.client))
    .bind(sqlx::types::Json(&input.line_items))
    .bind(totals.subtotal)
    .bind(totals.tax_total)
    .bind(totals.discount_total)
    .bind(totals.grand_total)
    .bind(clean(input.notes))
    .bind(clean(input.payment_terms))
    .bind(layout_json)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(InvoiceDto::from_row(row, is_pro)))
}

/// Moves the invoice to the recycle bin. It can be restored for 30 days, then the maintenance job removes it.
#[utoipa::path(delete, path = "/api/v1/invoices/{id}", tag = "invoices",
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 204), (status = 404)))]
pub async fn delete(
    State(state): State<AppState>,
    requester: Requester,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let row = load_owned(&state, &requester, id).await?;
    sqlx::query("UPDATE invoices SET deleted_at = now() WHERE id = $1")
        .bind(row.id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(get, path = "/api/v1/invoices/trash", tag = "invoices",
    responses((status = 200, description = "Invoices in the recycle bin, newest deletion first", body = [InvoiceDto]), (status = 401)))]
pub async fn trash_list(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<InvoiceDto>>> {
    let rows = sqlx::query_as::<_, InvoiceRow>(&format!(
        "SELECT {INVOICE_COLS} FROM invoices
          WHERE user_id = $1 AND deleted_at IS NOT NULL
            AND deleted_at > now() - interval '30 days'
          ORDER BY deleted_at DESC LIMIT 500"
    ))
    .bind(user.id())
    .fetch_all(&state.db)
    .await?;
    let pro = user.is_pro();
    Ok(Json(
        rows.into_iter()
            .map(|r| InvoiceDto::from_row(r, pro))
            .collect(),
    ))
}

#[utoipa::path(post, path = "/api/v1/invoices/{id}/restore", tag = "invoices",
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 200, body = InvoiceDto), (status = 404)))]
pub async fn restore(
    State(state): State<AppState>,
    requester: Requester,
    Path(id): Path<Uuid>,
) -> AppResult<Json<InvoiceDto>> {
    let row = load_trashed(&state, &requester, id).await?;
    let restored = sqlx::query_as::<_, InvoiceRow>(&format!(
        "UPDATE invoices SET deleted_at = NULL WHERE id = $1 RETURNING {INVOICE_COLS}"
    ))
    .bind(row.id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(InvoiceDto::from_row(restored, requester.is_pro())))
}

/// Delete forever. Only works on an invoice that is already in the recycle bin.
#[utoipa::path(delete, path = "/api/v1/invoices/{id}/permanent", tag = "invoices",
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 204), (status = 404)))]
pub async fn purge(
    State(state): State<AppState>,
    requester: Requester,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let row = load_trashed(&state, &requester, id).await?;
    sqlx::query("DELETE FROM invoices WHERE id = $1 AND deleted_at IS NOT NULL")
        .bind(row.id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/api/v1/invoices/trash", tag = "invoices",
    responses((status = 204), (status = 401)))]
pub async fn empty_trash(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM invoices WHERE user_id = $1 AND deleted_at IS NOT NULL")
        .bind(user.id())
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/v1/invoices/{id}/duplicate", tag = "invoices",
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 201, body = InvoiceDto), (status = 404)))]
pub async fn duplicate(
    State(state): State<AppState>,
    requester: Requester,
    Path(id): Path<Uuid>,
) -> AppResult<(StatusCode, Json<InvoiceDto>)> {
    let src = load_owned(&state, &requester, id).await?;
    let is_pro = requester.is_pro();
    let template_id = if is_pro {
        src.template_id
    } else {
        DEFAULT_TEMPLATE_ID
    };
    let number = next_invoice_number(&state, &requester).await?;
    let row = sqlx::query_as::<_, InvoiceRow>(&format!(
        "INSERT INTO invoices (user_id, guest_token, template_id, invoice_number, issue_date, due_date, currency,
                               business_info, client_info, line_items, subtotal, tax_total, discount_total,
                               grand_total, notes, payment_terms, layout_json, logo_png)
         SELECT user_id, guest_token, $2, $3, CURRENT_DATE,
                CASE WHEN due_date IS NULL THEN NULL ELSE CURRENT_DATE + (due_date - issue_date) END,
                currency, business_info, client_info, line_items, subtotal, tax_total, discount_total,
                grand_total, notes, payment_terms, layout_json, logo_png
           FROM invoices WHERE id = $1
         RETURNING {INVOICE_COLS}"
    ))
    .bind(src.id)
    .bind(template_id)
    .bind(&number)
    .fetch_one(&state.db)
    .await?;
    Ok((StatusCode::CREATED, Json(InvoiceDto::from_row(row, is_pro))))
}

/// Exact server-rendered PDF preview: precisely what a download would produce right now,
/// so it carries the watermark until the invoice is Pro or the watermark has been paid off.
#[utoipa::path(post, path = "/api/v1/invoices/{id}/render-preview", tag = "invoices",
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 200, content_type = "application/pdf"), (status = 404)))]
pub async fn render_preview(
    State(state): State<AppState>,
    requester: Requester,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let inv = load_owned(&state, &requester, id).await?;
    let watermark = !is_watermark_free(&state, &requester, inv.id).await?;
    let bytes = render_pdf(&state, &inv, requester.is_pro(), watermark).await?;
    Ok(pdf_response(bytes, &inv.invoice_number, true))
}

// ---------------------------------------------------------------------------
// Logo on the invoice itself (Guest/Free). Pro logos belong to templates.
// ---------------------------------------------------------------------------

fn ensure_editable(requester: &Requester, inv: &InvoiceRow) -> AppResult<()> {
    if !requester.is_pro() && inv.status != InvoiceStatus::Draft {
        return Err(AppError::conflict(
            "invoice_locked",
            "This invoice has been paid for and can't be edited. Duplicate it to make changes.",
        ));
    }
    Ok(())
}

pub async fn upload_logo(
    State(state): State<AppState>,
    requester: Requester,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> AppResult<StatusCode> {
    let inv = load_owned(&state, &requester, id).await?;
    ensure_editable(&requester, &inv)?;
    let field = multipart
        .next_field()
        .await
        .map_err(|_| AppError::bad_request("Invalid multipart body."))?
        .ok_or_else(|| AppError::bad_request("No file uploaded."))?;
    let bytes = field
        .bytes()
        .await
        .map_err(|_| AppError::bad_request("Upload failed or file too large."))?;
    if bytes.len() > templates::MAX_LOGO_BYTES {
        return Err(AppError::validation("Logo must be 1 MB or smaller."));
    }
    let png = tokio::task::spawn_blocking(move || templates::sanitize_logo(&bytes)).await??;
    sqlx::query("UPDATE invoices SET logo_png = $1, updated_at = now() WHERE id = $2")
        .bind(png)
        .bind(inv.id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_logo(
    State(state): State<AppState>,
    requester: Requester,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    let inv = load_owned(&state, &requester, id).await?;
    let bytes = invoice_logo(&state, inv.id)
        .await?
        .ok_or_else(AppError::not_found)?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "private, max-age=300"),
        ],
        bytes,
    )
        .into_response())
}

pub async fn delete_logo(
    State(state): State<AppState>,
    requester: Requester,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let inv = load_owned(&state, &requester, id).await?;
    ensure_editable(&requester, &inv)?;
    sqlx::query("UPDATE invoices SET logo_png = NULL, updated_at = now() WHERE id = $1")
        .bind(inv.id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

fn csv_field(s: &str) -> String {
    // Quote everything and neutralise spreadsheet formula injection.
    let s = if s.starts_with(['=', '+', '-', '@']) {
        format!("'{s}")
    } else {
        s.to_owned()
    };
    format!("\"{}\"", s.replace('"', "\"\""))
}

#[utoipa::path(get, path = "/api/v1/exports/invoices.csv", tag = "invoices",
    responses((status = 200, content_type = "text/csv"), (status = 403, description = "Pro only")))]
pub async fn export_csv(State(state): State<AppState>, user: AuthUser) -> AppResult<Response> {
    if !user.is_pro() {
        return Err(AppError::forbidden(
            "pro_required",
            "CSV export is available on Pro.",
        ));
    }
    let rows = sqlx::query_as::<_, InvoiceRow>(&format!(
        "SELECT {INVOICE_COLS} FROM invoices WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10000"
    ))
    .bind(user.id())
    .fetch_all(&state.db)
    .await?;
    let mut out = String::from(
        "invoice_number,status,issue_date,due_date,client,currency,subtotal,discount,tax,total\n",
    );
    for r in rows {
        let status = serde_json::to_value(r.status)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        out.push_str(
            &[
                csv_field(&r.invoice_number),
                csv_field(&status),
                csv_field(&r.issue_date.to_string()),
                csv_field(&r.due_date.map(|d| d.to_string()).unwrap_or_default()),
                csv_field(&r.client_info.name),
                csv_field(&r.currency),
                r.subtotal.to_string(),
                r.discount_total.to_string(),
                r.tax_total.to_string(),
                r.grand_total.to_string(),
            ]
            .join(","),
        );
        out.push('\n');
    }
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"invoices.csv\"",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        out,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_roundtrip() {
        let (ts, id) = (Utc::now(), Uuid::new_v4());
        let (ts2, id2) = decode_cursor(&encode_cursor(ts, id)).unwrap();
        assert_eq!(id, id2);
        assert_eq!(ts.timestamp_micros(), ts2.timestamp_micros());
        assert!(decode_cursor("not-a-cursor").is_err());
    }

    #[test]
    fn csv_neutralises_formulas() {
        assert_eq!(csv_field("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
        assert_eq!(csv_field("Acme"), "\"Acme\"");
    }
}
