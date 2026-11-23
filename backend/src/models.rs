//! Database rows, enums and API DTOs.

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{types::Json, FromRow};
use utoipa::ToSchema;
use uuid::Uuid;
use validator::{Validate, ValidationError};

use crate::invoice_calc::LineItem;

// ---------------------------------------------------------------------------
// Enums (mirrored as Postgres enum types)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, ToSchema)]
#[sqlx(type_name = "user_plan", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    Free,
    Pro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, ToSchema)]
#[sqlx(type_name = "invoice_status", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum InvoiceStatus {
    Draft,
    Paid,
    Downloaded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, ToSchema)]
#[sqlx(type_name = "payment_status", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum PaymentStatus {
    Pending,
    Succeeded,
    Failed,
    Refunded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type)]
#[sqlx(type_name = "email_token_kind", rename_all = "snake_case")]
pub enum EmailTokenKind {
    VerifyEmail,
    PasswordReset,
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

pub const USER_COLS: &str =
    "id, email, plan, plan_renews_at, stripe_customer_id, email_verified_at, is_admin, created_at";

/// User row without the password hash (which is only ever read during login).
#[derive(Debug, Clone, FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub email: String,
    pub plan: Plan,
    pub plan_renews_at: Option<DateTime<Utc>>,
    pub stripe_customer_id: Option<String>,
    pub email_verified_at: Option<DateTime<Utc>>,
    pub is_admin: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserDto {
    pub id: Uuid,
    pub email: String,
    pub plan: Plan,
    pub plan_renews_at: Option<DateTime<Utc>>,
    pub email_verified: bool,
    pub has_billing_account: bool,
    pub is_admin: bool,
    pub created_at: DateTime<Utc>,
}

impl From<&UserRow> for UserDto {
    fn from(u: &UserRow) -> Self {
        Self {
            id: u.id,
            email: u.email.clone(),
            plan: u.plan,
            plan_renews_at: u.plan_renews_at,
            email_verified: u.email_verified_at.is_some(),
            has_billing_account: u.stripe_customer_id.is_some(),
            is_admin: u.is_admin,
            created_at: u.created_at,
        }
    }
}

pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

// ---------------------------------------------------------------------------
// Invoice parties
// ---------------------------------------------------------------------------

fn optional_email(value: &str) -> Result<(), ValidationError> {
    if value.is_empty() || validator::ValidateEmail::validate_email(&value) {
        Ok(())
    } else {
        Err(ValidationError::new("email"))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Party {
    #[serde(default)]
    #[validate(length(max = 200))]
    pub name: String,
    #[serde(default)]
    #[validate(length(max = 254), custom(function = "optional_email"))]
    pub email: String,
    #[serde(default)]
    #[validate(length(max = 50))]
    pub phone: String,
    #[serde(default)]
    #[validate(length(max = 500))]
    pub address: String,
    #[serde(default)]
    #[validate(length(max = 64))]
    pub tax_id: String,
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum FontFamily {
    Helvetica,
    Times,
    Courier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum HeaderStyle {
    Band,
    Tinted,
    Minimal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum LogoPosition {
    Left,
    Right,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Density {
    Compact,
    Comfortable,
}

fn hex_color(value: &str) -> Result<(), ValidationError> {
    let ok = value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        Ok(())
    } else {
        Err(ValidationError::new("hex_color"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CustomField {
    #[validate(length(min = 1, max = 40))]
    pub label: String,
    #[validate(length(max = 120))]
    pub value: String,
}

/// Everything a Pro user can customise. Validated server-side on every write.
#[derive(Debug, Clone, Serialize, Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TemplateLayout {
    pub font: FontFamily,
    #[validate(custom(function = "hex_color"))]
    pub primary_color: String,
    #[validate(custom(function = "hex_color"))]
    pub accent_color: String,
    #[validate(custom(function = "hex_color"))]
    pub text_color: String,
    pub header_style: HeaderStyle,
    pub logo_position: LogoPosition,
    pub show_tax_column: bool,
    pub show_discount_column: bool,
    #[validate(length(max = 30))]
    pub title_text: String,
    #[validate(length(max = 300))]
    pub footer_text: String,
    #[validate(length(max = 8), nested)]
    pub custom_fields: Vec<CustomField>,
    pub density: Density,
    /// Elements the user removed from the invoice (Pro). Ids come from `HIDEABLE_FIELDS`.
    #[serde(default)]
    #[validate(custom(function = "hideable_fields"))]
    pub hidden_fields: Vec<String>,
}

/// Invoice elements a Pro user may remove. Mirrors the ids used by the editor canvas.
pub const HIDEABLE_FIELDS: &[&str] = &[
    "header.number",
    "business.address",
    "business.email",
    "business.phone",
    "business.taxId",
    "client.address",
    "client.email",
    "client.phone",
    "client.taxId",
    "detail.invoiceNumber",
    "detail.issueDate",
    "detail.dueDate",
    "detail.currency",
    "paymentTerms",
    "notes",
    "footer",
];

fn hideable_fields(ids: &[String]) -> Result<(), ValidationError> {
    let mut seen = std::collections::HashSet::new();
    let ok = ids
        .iter()
        .all(|id| HIDEABLE_FIELDS.contains(&id.as_str()) && seen.insert(id.as_str()));
    if ok {
        Ok(())
    } else {
        Err(ValidationError::new("hidden_fields"))
    }
}

impl TemplateLayout {
    /// True when the user removed this element from the invoice.
    pub fn hides(&self, id: &str) -> bool {
        self.hidden_fields.iter().any(|h| h == id)
    }

    /// Taking fields and columns off the invoice is Pro only: for everyone else every field and
    /// column stays, whatever the client sent or an older save contains.
    pub fn without_removals(mut self) -> Self {
        self.hidden_fields.clear();
        self.show_tax_column = true;
        self.show_discount_column = true;
        self
    }

    /// What a saved ("My templates") template keeps of the layout: everything, footer included, except the
    /// values typed into custom fields (a PO number and the like changes with every invoice). The labels stay.
    pub fn for_saved_template(mut self) -> Self {
        for f in &mut self.custom_fields {
            f.value.clear();
        }
        self
    }
}

/// The invoice details a saved template keeps: the ones that stay the same from invoice to invoice.
/// Client, line items, invoice number and dates are deliberately not part of it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Validate, ToSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TemplateContent {
    /// The "From" block in the header.
    #[serde(default)]
    #[validate(nested)]
    pub business: Party,
    #[serde(default)]
    #[validate(length(max = 3))]
    pub currency: String,
    #[serde(default)]
    #[validate(length(max = 300))]
    pub payment_terms: String,
    #[serde(default)]
    #[validate(length(max = 2000))]
    pub notes: String,
}

impl Default for TemplateLayout {
    fn default() -> Self {
        Self {
            font: FontFamily::Helvetica,
            primary_color: "#2E3A8C".into(),
            accent_color: "#10B981".into(),
            text_color: "#111827".into(),
            header_style: HeaderStyle::Band,
            logo_position: LogoPosition::None,
            show_tax_column: true,
            show_discount_column: true,
            title_text: "INVOICE".into(),
            footer_text: "Thank you for your business.".into(),
            custom_fields: vec![],
            density: Density::Comfortable,
            hidden_fields: vec![],
        }
    }
}

pub const TEMPLATE_COLS: &str =
    "id, user_id, name, is_default, saved, layout_json, content_json, (logo_png IS NOT NULL) AS has_logo, created_at, updated_at, deleted_at";

#[derive(Debug, Clone, FromRow)]
pub struct TemplateRow {
    pub id: Uuid,
    /// Owner (NULL for the system default). Selected for completeness/debugging.
    #[allow(dead_code)]
    pub user_id: Option<Uuid>,
    pub name: String,
    pub is_default: bool,
    pub saved: bool,
    pub layout_json: Json<TemplateLayout>,
    pub content_json: Option<Json<TemplateContent>>,
    pub has_logo: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Set while the template sits in the recycle bin.
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDto {
    pub id: Uuid,
    pub name: String,
    pub is_default: bool,
    /// A named template the Pro user chose to keep ("My templates"), as opposed to the ones the editor manages itself.
    pub saved: bool,
    pub layout: TemplateLayout,
    /// Saved templates: the invoice details that come with the template (business details, currency, terms, notes).
    #[serde(default)]
    pub content: Option<TemplateContent>,
    pub has_logo: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// When it was moved to the recycle bin (null otherwise). It is removed for good 30 days later.
    #[serde(default)]
    pub deleted_at: Option<DateTime<Utc>>,
}

impl From<TemplateRow> for TemplateDto {
    fn from(r: TemplateRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            is_default: r.is_default,
            saved: r.saved,
            layout: r.layout_json.0,
            content: r.content_json.map(|c| c.0),
            has_logo: r.has_logo,
            created_at: r.created_at,
            updated_at: r.updated_at,
            deleted_at: r.deleted_at,
        }
    }
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

pub const INVOICE_COLS: &str = "id, user_id, template_id, guest_token, status, invoice_number, issue_date, \
     due_date, currency, business_info, client_info, line_items, subtotal, tax_total, discount_total, \
     grand_total, notes, payment_terms, created_at, updated_at, layout_json, (logo_png IS NOT NULL) AS has_logo, \
     downloaded_at, deleted_at";

#[derive(Debug, Clone, FromRow)]
pub struct InvoiceRow {
    pub id: Uuid,
    /// Ownership columns: enforced in SQL (`load_owned`), never exposed in DTOs.
    #[allow(dead_code)]
    pub user_id: Option<Uuid>,
    pub template_id: Uuid,
    #[allow(dead_code)]
    pub guest_token: Option<String>,
    pub status: InvoiceStatus,
    pub invoice_number: String,
    pub issue_date: NaiveDate,
    pub due_date: Option<NaiveDate>,
    pub currency: String,
    pub business_info: Json<Party>,
    pub client_info: Json<Party>,
    pub line_items: Json<Vec<LineItem>>,
    pub subtotal: Decimal,
    pub tax_total: Decimal,
    pub discount_total: Decimal,
    pub grand_total: Decimal,
    pub notes: Option<String>,
    pub payment_terms: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Guest/Free customizations of the Classic template (Pro uses `template_id`).
    pub layout_json: Option<Json<TemplateLayout>>,
    /// True when a logo is stored on the invoice itself. The bytes are fetched separately.
    pub has_logo: bool,
    /// When the PDF was last downloaded. Unlike `status`, a free watermarked download sets this too.
    pub downloaded_at: Option<DateTime<Utc>>,
    /// When it was moved to the recycle bin; it is removed for good 30 days later.
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceDto {
    pub id: Uuid,
    pub template_id: Uuid,
    pub status: InvoiceStatus,
    /// True when a non-Pro invoice has been paid for: edits are blocked so one
    /// payment can't be reused for a different invoice. Duplicate it instead.
    pub locked: bool,
    pub invoice_number: String,
    pub issue_date: NaiveDate,
    pub due_date: Option<NaiveDate>,
    pub currency: String,
    pub business: Party,
    pub client: Party,
    pub line_items: Vec<LineItem>,
    pub subtotal: Decimal,
    pub tax_total: Decimal,
    pub discount_total: Decimal,
    pub grand_total: Decimal,
    pub notes: Option<String>,
    pub payment_terms: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Customizations stored on the invoice (Guest/Free). Null for the plain Classic look.
    pub layout: Option<TemplateLayout>,
    pub has_logo: bool,
    /// When the PDF was last downloaded, if ever.
    pub downloaded_at: Option<DateTime<Utc>>,
    /// Set only while the invoice is in the recycle bin.
    pub deleted_at: Option<DateTime<Utc>>,
}

impl InvoiceDto {
    pub fn from_row(r: InvoiceRow, requester_is_pro: bool) -> Self {
        Self {
            locked: !requester_is_pro && r.status != InvoiceStatus::Draft,
            id: r.id,
            template_id: r.template_id,
            status: r.status,
            invoice_number: r.invoice_number,
            issue_date: r.issue_date,
            due_date: r.due_date,
            currency: r.currency,
            business: r.business_info.0,
            client: r.client_info.0,
            line_items: r.line_items.0,
            subtotal: r.subtotal,
            tax_total: r.tax_total,
            discount_total: r.discount_total,
            grand_total: r.grand_total,
            notes: r.notes,
            payment_terms: r.payment_terms,
            created_at: r.created_at,
            updated_at: r.updated_at,
            layout: r.layout_json.map(|j| j.0),
            has_logo: r.has_logo,
            downloaded_at: r.downloaded_at,
            deleted_at: r.deleted_at,
        }
    }
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Pricing {
    pub download_price_cents: i32,
    pub currency: String,
    pub pro_monthly_cents: i32,
    pub pro_annual_cents: i32,
}
