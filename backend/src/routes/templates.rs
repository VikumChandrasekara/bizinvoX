//! Templates. Guests/Free users only ever see the system default; every write
//! endpoint requires `plan == pro` (checked against the DB row, never the client).

use std::io::Cursor;

use axum::{
    extract::{Multipart, Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use image::{io::Limits, ImageFormat, ImageOutputFormat};
use serde::Deserialize;
use utoipa::ToSchema;
use uuid::Uuid;
use validator::Validate;

use crate::{
    cache,
    error::{AppError, AppResult, ValidJson},
    extract::{AuthUser, MaybeUser, Requester},
    models::{TemplateContent, TemplateDto, TemplateLayout, TemplateRow, TEMPLATE_COLS},
    state::AppState,
};

pub const DEFAULT_TEMPLATE_ID: Uuid = Uuid::from_u128(1);
const DEFAULT_KEY: &str = "template:default";
const DEFAULT_TTL: u64 = 24 * 3600;
const USER_TTL: u64 = 30 * 60;
pub const MAX_LOGO_BYTES: usize = 1024 * 1024;

fn user_key(user_id: Uuid, id: Uuid) -> String {
    format!("template:{user_id}:{id}")
}

#[derive(Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TemplateInput {
    #[validate(length(min = 1, max = 80))]
    pub name: String,
    #[validate(nested)]
    pub layout: TemplateLayout,
    /// Keep this as a named template in "My templates". Only read when creating; renaming or restyling never changes it.
    #[serde(default)]
    pub saved: bool,
    /// Saved templates only: the invoice details that come with it (business details, currency, terms, notes).
    /// Left out on a rename, the stored details are kept.
    #[serde(default)]
    #[validate(nested)]
    pub content: Option<TemplateContent>,
}

/// How many named templates one Pro account can keep.
const MAX_SAVED_TEMPLATES: i64 = 50;

fn require_pro(user: &AuthUser) -> AppResult<()> {
    if user.is_pro() {
        Ok(())
    } else {
        Err(AppError::pro_required())
    }
}

pub async fn default_template(state: &AppState) -> AppResult<TemplateDto> {
    if let Some(t) = cache::get_json::<TemplateDto>(&state.redis, DEFAULT_KEY).await {
        return Ok(t);
    }
    let row = sqlx::query_as::<_, TemplateRow>(&format!(
        "SELECT {TEMPLATE_COLS} FROM templates WHERE id = $1"
    ))
    .bind(DEFAULT_TEMPLATE_ID)
    .fetch_one(&state.db)
    .await?;
    let dto = TemplateDto::from(row);
    cache::set_json(&state.redis, DEFAULT_KEY, &dto, DEFAULT_TTL).await;
    Ok(dto)
}

async fn owned_template(state: &AppState, user_id: Uuid, id: Uuid) -> AppResult<TemplateDto> {
    let key = user_key(user_id, id);
    if let Some(t) = cache::get_json::<TemplateDto>(&state.redis, &key).await {
        return Ok(t);
    }
    let row = sqlx::query_as::<_, TemplateRow>(&format!(
        "SELECT {TEMPLATE_COLS} FROM templates WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(AppError::not_found)?;
    let dto = TemplateDto::from(row);
    cache::set_json(&state.redis, &key, &dto, USER_TTL).await;
    Ok(dto)
}

async fn invalidate(state: &AppState, user_id: Uuid, id: Uuid) {
    cache::del(&state.redis, &[user_key(user_id, id)]).await;
}

/// Which template an invoice may use. Non-default templates require Pro + ownership.
pub async fn resolve_template_id(
    state: &AppState,
    requester: &Requester,
    requested: Option<Uuid>,
) -> AppResult<Uuid> {
    let id = match requested {
        None => return Ok(DEFAULT_TEMPLATE_ID),
        Some(id) if id == DEFAULT_TEMPLATE_ID => return Ok(DEFAULT_TEMPLATE_ID),
        Some(id) => id,
    };
    let user = requester.user().filter(|u| u.is_pro()).ok_or_else(|| {
        AppError::forbidden(
            "template_forbidden",
            "Custom templates require a Pro subscription.",
        )
    })?;
    let owned: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM templates WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL)",
    )
    .bind(id)
    .bind(user.id())
    .fetch_one(&state.db)
    .await?;
    if owned {
        Ok(id)
    } else {
        Err(AppError::forbidden(
            "template_forbidden",
            "You don't have access to that template.",
        ))
    }
}

/// Layout + logo for rendering. Callers pass DEFAULT_TEMPLATE_ID for non-Pro
/// requesters, so a lapsed Pro user's custom templates are preserved but locked.
pub async fn layout_for_render(
    state: &AppState,
    template_id: Uuid,
) -> AppResult<(TemplateLayout, Option<Vec<u8>>)> {
    if template_id == DEFAULT_TEMPLATE_ID {
        return Ok((default_template(state).await?.layout, None));
    }
    let row: Option<(sqlx::types::Json<TemplateLayout>, Option<Vec<u8>>)> =
        sqlx::query_as("SELECT layout_json, logo_png FROM templates WHERE id = $1")
            .bind(template_id)
            .fetch_optional(&state.db)
            .await?;
    match row {
        Some((layout, logo)) => Ok((layout.0, logo)),
        None => Ok((default_template(state).await?.layout, None)),
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[utoipa::path(get, path = "/api/v1/templates", tag = "templates",
    responses((status = 200, description = "Pro: default + own templates. Others: default only.", body = [TemplateDto])))]
pub async fn list(
    State(state): State<AppState>,
    user: MaybeUser,
) -> AppResult<Json<Vec<TemplateDto>>> {
    let mut out = vec![default_template(&state).await?];
    if let Some(user) = user.0.filter(AuthUser::is_pro) {
        let rows = sqlx::query_as::<_, TemplateRow>(&format!(
            "SELECT {TEMPLATE_COLS} FROM templates WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 500"
        ))
        .bind(user.id())
        .fetch_all(&state.db)
        .await?;
        out.extend(rows.into_iter().map(TemplateDto::from));
    }
    Ok(Json(out))
}

#[utoipa::path(get, path = "/api/v1/templates/{id}", tag = "templates",
    params(("id" = Uuid, Path, description = "Template id")),
    responses((status = 200, body = TemplateDto), (status = 403), (status = 404)))]
pub async fn get_one(
    State(state): State<AppState>,
    user: MaybeUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<TemplateDto>> {
    if id == DEFAULT_TEMPLATE_ID {
        return Ok(Json(default_template(&state).await?));
    }
    match user.0 {
        Some(u) if u.is_pro() => Ok(Json(owned_template(&state, u.id(), id).await?)),
        _ => Err(AppError::pro_required()),
    }
}

#[utoipa::path(post, path = "/api/v1/templates", tag = "templates", request_body = TemplateInput,
    responses((status = 201, body = TemplateDto), (status = 403, description = "Pro required")))]
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ValidJson(input): ValidJson<TemplateInput>,
) -> AppResult<(StatusCode, Json<TemplateDto>)> {
    require_pro(&user)?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::validation("Give the template a name."));
    }
    // A saved template keeps the look and the details that stay the same on every invoice, never one invoice's own data.
    let layout = if input.saved { input.layout.clone().for_saved_template() } else { input.layout.clone() };
    let content = if input.saved { input.content.clone().map(sqlx::types::Json) } else { None };
    if input.saved {
        let count: i64 =
            sqlx::query_scalar(
                "SELECT count(*) FROM templates WHERE user_id = $1 AND saved AND deleted_at IS NULL",
            )
            .bind(user.id())
            .fetch_one(&state.db)
            .await?;
        if count >= MAX_SAVED_TEMPLATES {
            return Err(AppError::validation(
                "You can keep up to 50 saved templates. Delete one to save another.",
            ));
        }
    }
    let row = sqlx::query_as::<_, TemplateRow>(&format!(
        "INSERT INTO templates (user_id, name, layout_json, saved, content_json) VALUES ($1, $2, $3, $4, $5) RETURNING {TEMPLATE_COLS}"
    ))
    .bind(user.id())
    .bind(name)
    .bind(sqlx::types::Json(&layout))
    .bind(input.saved)
    .bind(content)
    .fetch_one(&state.db)
    .await?;
    Ok((StatusCode::CREATED, Json(row.into())))
}

#[utoipa::path(put, path = "/api/v1/templates/{id}", tag = "templates", request_body = TemplateInput,
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 200, body = TemplateDto), (status = 403), (status = 404)))]
pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    ValidJson(input): ValidJson<TemplateInput>,
) -> AppResult<Json<TemplateDto>> {
    require_pro(&user)?;
    if id == DEFAULT_TEMPLATE_ID {
        return Err(AppError::forbidden(
            "default_template_readonly",
            "Duplicate the default template to customize it.",
        ));
    }
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::validation("Give the template a name."));
    }
    let row = sqlx::query_as::<_, TemplateRow>(&format!(
        "UPDATE templates SET name = $1, layout_json = CASE WHEN saved THEN $5::jsonb ELSE $2::jsonb END,
                content_json = CASE WHEN saved THEN COALESCE($6::jsonb, content_json) ELSE content_json END,
                updated_at = now()
          WHERE id = $3 AND user_id = $4 AND deleted_at IS NULL RETURNING {TEMPLATE_COLS}"
    ))
    .bind(name)
    .bind(sqlx::types::Json(&input.layout))
    .bind(id)
    .bind(user.id())
    // A saved template never keeps one invoice's own data, whatever the client sends along.
    .bind(sqlx::types::Json(input.layout.clone().for_saved_template()))
    .bind(input.content.clone().map(sqlx::types::Json))
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(AppError::not_found)?;
    invalidate(&state, user.id(), id).await;
    Ok(Json(row.into()))
}

#[utoipa::path(delete, path = "/api/v1/templates/{id}", tag = "templates",
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 204), (status = 403), (status = 404)))]
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    require_pro(&user)?;
    // Into the recycle bin: restorable for 30 days, then removed by the maintenance job.
    let deleted = sqlx::query(
        "UPDATE templates SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(user.id())
    .execute(&state.db)
    .await?
    .rows_affected();
    if deleted == 0 {
        return Err(AppError::not_found());
    }
    invalidate(&state, user.id(), id).await;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(get, path = "/api/v1/templates/trash", tag = "templates",
    responses((status = 200, description = "Saved templates in the recycle bin", body = [TemplateDto]), (status = 403)))]
pub async fn trash_list(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<TemplateDto>>> {
    require_pro(&user)?;
    let rows = sqlx::query_as::<_, TemplateRow>(&format!(
        "SELECT {TEMPLATE_COLS} FROM templates
          WHERE user_id = $1 AND saved AND deleted_at IS NOT NULL
            AND deleted_at > now() - interval '30 days'
          ORDER BY deleted_at DESC LIMIT 200"
    ))
    .bind(user.id())
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(TemplateDto::from).collect()))
}

#[utoipa::path(post, path = "/api/v1/templates/{id}/restore", tag = "templates",
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 200, body = TemplateDto), (status = 403), (status = 404)))]
pub async fn restore(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<TemplateDto>> {
    require_pro(&user)?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM templates WHERE user_id = $1 AND saved AND deleted_at IS NULL",
    )
    .bind(user.id())
    .fetch_one(&state.db)
    .await?;
    if count >= MAX_SAVED_TEMPLATES {
        return Err(AppError::validation(
            "You can keep up to 50 saved templates. Delete one to restore this one.",
        ));
    }
    let row = sqlx::query_as::<_, TemplateRow>(&format!(
        "UPDATE templates SET deleted_at = NULL
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL RETURNING {TEMPLATE_COLS}"
    ))
    .bind(id)
    .bind(user.id())
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(AppError::not_found)?;
    invalidate(&state, user.id(), id).await;
    Ok(Json(row.into()))
}

/// Delete forever. Only works on a template that is already in the recycle bin.
#[utoipa::path(delete, path = "/api/v1/templates/{id}/permanent", tag = "templates",
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 204), (status = 403), (status = 404)))]
pub async fn purge(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    require_pro(&user)?;
    let removed = sqlx::query(
        "DELETE FROM templates WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL",
    )
    .bind(id)
    .bind(user.id())
    .execute(&state.db)
    .await?
    .rows_affected();
    if removed == 0 {
        return Err(AppError::not_found());
    }
    invalidate(&state, user.id(), id).await;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/api/v1/templates/trash", tag = "templates",
    responses((status = 204), (status = 403)))]
pub async fn empty_trash(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<StatusCode> {
    require_pro(&user)?;
    sqlx::query("DELETE FROM templates WHERE user_id = $1 AND saved AND deleted_at IS NOT NULL")
        .bind(user.id())
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/v1/templates/{id}/duplicate", tag = "templates",
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 201, body = TemplateDto), (status = 403), (status = 404)))]
pub async fn duplicate(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<(StatusCode, Json<TemplateDto>)> {
    require_pro(&user)?;
    let row = sqlx::query_as::<_, TemplateRow>(&format!(
        "INSERT INTO templates (user_id, name, layout_json, logo_png, saved, content_json)
         SELECT $1, left(name || ' (copy)', 80), layout_json, logo_png, saved, content_json
           FROM templates WHERE id = $2 AND (user_id = $1 OR is_default) AND deleted_at IS NULL
         RETURNING {TEMPLATE_COLS}"
    ))
    .bind(user.id())
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(AppError::not_found)?;
    Ok((StatusCode::CREATED, Json(row.into())))
}

/// Validate by content sniffing (not extension), cap dimensions/allocation,
/// then decode and re-encode as PNG - which drops metadata and anything
/// smuggled inside the original container.
pub fn sanitize_logo(bytes: &[u8]) -> AppResult<Vec<u8>> {
    let unsupported = || AppError::validation("Logo must be a PNG, JPEG or WebP image.");
    let format = image::guess_format(bytes).map_err(|_| unsupported())?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err(unsupported());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    let mut reader = image::io::Reader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let img = reader.decode().map_err(|_| unsupported())?;
    // Downscale only (thumbnail() would also upscale small logos).
    let img = if img.width() > 800 || img.height() > 400 {
        img.thumbnail(800, 400)
    } else {
        img
    };
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, ImageOutputFormat::Png)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("png encode: {e}")))?;
    Ok(out.into_inner())
}

#[utoipa::path(put, path = "/api/v1/templates/{id}/logo", tag = "templates",
    params(("id" = Uuid, Path, description = "Resource id")),
    request_body(content = String, content_type = "multipart/form-data", description = "Single file field (PNG/JPEG/WebP, max 1 MB)"),
    responses((status = 200, body = TemplateDto), (status = 403), (status = 422)))]
pub async fn upload_logo(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> AppResult<Json<TemplateDto>> {
    require_pro(&user)?;
    let field = multipart
        .next_field()
        .await
        .map_err(|_| AppError::bad_request("Invalid multipart body."))?
        .ok_or_else(|| AppError::bad_request("No file uploaded."))?;
    let bytes = field
        .bytes()
        .await
        .map_err(|_| AppError::bad_request("Upload failed or file too large."))?;
    if bytes.len() > MAX_LOGO_BYTES {
        return Err(AppError::validation("Logo must be 1 MB or smaller."));
    }
    let png = tokio::task::spawn_blocking(move || sanitize_logo(&bytes)).await??;
    let row = sqlx::query_as::<_, TemplateRow>(&format!(
        "UPDATE templates SET logo_png = $1, updated_at = now()
          WHERE id = $2 AND user_id = $3 RETURNING {TEMPLATE_COLS}"
    ))
    .bind(png)
    .bind(id)
    .bind(user.id())
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(AppError::not_found)?;
    invalidate(&state, user.id(), id).await;
    Ok(Json(row.into()))
}

#[utoipa::path(get, path = "/api/v1/templates/{id}/logo", tag = "templates",
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 200, content_type = "image/png"), (status = 404)))]
pub async fn get_logo(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    require_pro(&user)?;
    let logo: Option<Option<Vec<u8>>> =
        sqlx::query_scalar("SELECT logo_png FROM templates WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user.id())
            .fetch_optional(&state.db)
            .await?;
    let bytes = logo.flatten().ok_or_else(AppError::not_found)?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "private, max-age=300"),
        ],
        bytes,
    )
        .into_response())
}

#[utoipa::path(delete, path = "/api/v1/templates/{id}/logo", tag = "templates",
    params(("id" = Uuid, Path, description = "Resource id")), responses((status = 200, body = TemplateDto)))]
pub async fn delete_logo(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<TemplateDto>> {
    require_pro(&user)?;
    let row = sqlx::query_as::<_, TemplateRow>(&format!(
        "UPDATE templates SET logo_png = NULL, updated_at = now()
          WHERE id = $1 AND user_id = $2 RETURNING {TEMPLATE_COLS}"
    ))
    .bind(id)
    .bind(user.id())
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(AppError::not_found)?;
    invalidate(&state, user.id(), id).await;
    Ok(Json(row.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logo_sanitizer_accepts_png_and_rejects_garbage() {
        let img = image::DynamicImage::new_rgba8(20, 10);
        let mut png = Cursor::new(Vec::new());
        img.write_to(&mut png, ImageOutputFormat::Png).unwrap();
        let out = sanitize_logo(&png.into_inner()).unwrap();
        assert!(out.starts_with(&[0x89, b'P', b'N', b'G']));

        assert!(sanitize_logo(b"<svg onload=alert(1)>").is_err());
        assert!(sanitize_logo(b"GIF89a....").is_err());
    }
}
