//! Minimal Stripe REST client (form-encoded, as Stripe expects) plus webhook
//! signature verification. Card data never touches our servers: we only create
//! hosted Checkout / Billing Portal sessions.

use axum::http::StatusCode;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use uuid::Uuid;

use crate::{error::AppError, security::constant_time_eq};

const API: &str = "https://api.stripe.com/v1";
const SIGNATURE_TOLERANCE_SECS: i64 = 300;

pub struct Stripe {
    http: reqwest::Client,
    secret_key: Option<String>,
    webhook_secret: Option<String>,
}

pub struct CheckoutSession {
    pub id: String,
    pub url: String,
}

pub struct DownloadCheckout<'a> {
    pub invoice_id: Uuid,
    pub payment_id: Uuid,
    pub invoice_number: &'a str,
    pub amount_cents: i32,
    pub currency: &'a str,
    pub customer_email: Option<&'a str>,
    pub success_url: String,
    pub cancel_url: String,
}

fn unavailable() -> AppError {
    AppError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "payments_unavailable",
        "Payments are not configured on this server.",
    )
}

impl Stripe {
    pub fn new(
        http: reqwest::Client,
        secret_key: Option<String>,
        webhook_secret: Option<String>,
    ) -> Self {
        Self {
            http,
            secret_key,
            webhook_secret,
        }
    }

    fn key(&self) -> Result<&str, AppError> {
        self.secret_key.as_deref().ok_or_else(unavailable)
    }

    async fn parse(res: Result<reqwest::Response, reqwest::Error>) -> Result<Value, AppError> {
        let res = res.map_err(|e| AppError::Upstream(format!("stripe request failed: {e}")))?;
        let status = res.status();
        let body: Value = res
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("stripe response unreadable: {e}")))?;
        if !status.is_success() {
            let msg = body["error"]["message"].as_str().unwrap_or("unknown error");
            return Err(AppError::Upstream(format!("stripe {status}: {msg}")));
        }
        Ok(body)
    }

    async fn post(
        &self,
        path: &str,
        form: &[(&str, String)],
        idempotency_key: Option<&str>,
    ) -> Result<Value, AppError> {
        let mut req = self
            .http
            .post(format!("{API}{path}"))
            .bearer_auth(self.key()?)
            .form(form);
        if let Some(key) = idempotency_key {
            req = req.header("Idempotency-Key", key);
        }
        Self::parse(req.send().await).await
    }

    async fn get(&self, path: &str) -> Result<Value, AppError> {
        let req = self
            .http
            .get(format!("{API}{path}"))
            .bearer_auth(self.key()?);
        Self::parse(req.send().await).await
    }

    fn session_from(v: Value) -> Result<CheckoutSession, AppError> {
        match (v["id"].as_str(), v["url"].as_str()) {
            (Some(id), Some(url)) => Ok(CheckoutSession {
                id: id.to_owned(),
                url: url.to_owned(),
            }),
            _ => Err(AppError::Upstream(
                "stripe checkout session missing id/url".into(),
            )),
        }
    }

    pub async fn create_download_checkout(
        &self,
        p: DownloadCheckout<'_>,
    ) -> Result<CheckoutSession, AppError> {
        let number: String = p.invoice_number.chars().take(40).collect();
        let mut form: Vec<(&str, String)> = vec![
            ("mode", "payment".into()),
            ("line_items[0][quantity]", "1".into()),
            (
                "line_items[0][price_data][currency]",
                p.currency.to_lowercase(),
            ),
            (
                "line_items[0][price_data][unit_amount]",
                p.amount_cents.to_string(),
            ),
            (
                "line_items[0][price_data][product_data][name]",
                format!("Remove watermark - invoice {number}"),
            ),
            ("success_url", p.success_url),
            ("cancel_url", p.cancel_url),
            ("client_reference_id", p.invoice_id.to_string()),
            ("metadata[kind]", "single_download".into()),
            ("metadata[invoice_id]", p.invoice_id.to_string()),
            ("metadata[payment_id]", p.payment_id.to_string()),
            (
                "payment_intent_data[metadata][invoice_id]",
                p.invoice_id.to_string(),
            ),
            (
                "payment_intent_data[metadata][payment_id]",
                p.payment_id.to_string(),
            ),
        ];
        if let Some(email) = p.customer_email {
            form.push(("customer_email", email.to_owned()));
        }
        let idem = format!("download-checkout-{}", p.payment_id);
        Self::session_from(self.post("/checkout/sessions", &form, Some(&idem)).await?)
    }

    pub async fn create_customer(&self, email: &str, user_id: Uuid) -> Result<String, AppError> {
        let form = [
            ("email", email.to_owned()),
            ("metadata[user_id]", user_id.to_string()),
        ];
        let v = self
            .post("/customers", &form, Some(&format!("customer-{user_id}")))
            .await?;
        v["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| AppError::Upstream("stripe customer missing id".into()))
    }

    pub async fn create_subscription_checkout(
        &self,
        customer_id: &str,
        price_id: &str,
        user_id: Uuid,
        success_url: String,
        cancel_url: String,
    ) -> Result<CheckoutSession, AppError> {
        let form: Vec<(&str, String)> = vec![
            ("mode", "subscription".into()),
            ("customer", customer_id.to_owned()),
            ("line_items[0][price]", price_id.to_owned()),
            ("line_items[0][quantity]", "1".into()),
            ("success_url", success_url),
            ("cancel_url", cancel_url),
            ("client_reference_id", user_id.to_string()),
            ("allow_promotion_codes", "true".into()),
            ("metadata[kind]", "pro_subscription".into()),
            ("metadata[user_id]", user_id.to_string()),
            ("subscription_data[metadata][user_id]", user_id.to_string()),
        ];
        Self::session_from(self.post("/checkout/sessions", &form, None).await?)
    }

    pub async fn create_portal_session(
        &self,
        customer_id: &str,
        return_url: String,
    ) -> Result<String, AppError> {
        let form = [
            ("customer", customer_id.to_owned()),
            ("return_url", return_url),
        ];
        let v = self.post("/billing_portal/sessions", &form, None).await?;
        v["url"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| AppError::Upstream("stripe portal session missing url".into()))
    }

    pub async fn retrieve_checkout_session(&self, session_id: &str) -> Result<Value, AppError> {
        if !is_stripe_id(session_id, "cs_") {
            return Err(AppError::bad_request("Invalid checkout session id."));
        }
        self.get(&format!("/checkout/sessions/{session_id}")).await
    }

    pub async fn retrieve_subscription(&self, subscription_id: &str) -> Result<Value, AppError> {
        if !is_stripe_id(subscription_id, "sub_") {
            return Err(AppError::bad_request("Invalid subscription id."));
        }
        self.get(&format!("/subscriptions/{subscription_id}")).await
    }

    /// Whether a Stripe secret key is set (payments work at all).
    pub fn is_configured(&self) -> bool {
        self.secret_key.is_some()
    }

    /// Stop (or undo stopping) the renewal at the end of the paid period. The customer keeps
    /// Pro until then. Resuming also clears a `cancel_at` date set from the Stripe portal.
    pub async fn set_cancel_at_period_end(
        &self,
        subscription_id: &str,
        cancel: bool,
    ) -> Result<Value, AppError> {
        if !is_stripe_id(subscription_id, "sub_") {
            return Err(AppError::bad_request("Invalid subscription id."));
        }
        let mut form: Vec<(&str, String)> = vec![("cancel_at_period_end", cancel.to_string())];
        if !cancel {
            form.push(("cancel_at", String::new()));
        }
        self.post(&format!("/subscriptions/{subscription_id}"), &form, None)
            .await
    }

    /// The card that pays for the subscription (`brand`, `last4`, `exp_month`, `exp_year`), or
    /// None. Best effort: the page still works when Stripe can't be reached.
    pub async fn default_card(
        &self,
        customer_id: &str,
        subscription_id: Option<&str>,
    ) -> Option<Value> {
        if let Some(sub) = subscription_id.filter(|s| is_stripe_id(s, "sub_")) {
            let v = self
                .get(&format!(
                    "/subscriptions/{sub}?expand[]=default_payment_method"
                ))
                .await
                .ok()?;
            if v["default_payment_method"]["card"].is_object() {
                return Some(v["default_payment_method"]["card"].clone());
            }
        }
        if !is_stripe_id(customer_id, "cus_") {
            return None;
        }
        let v = self
            .get(&format!(
                "/customers/{customer_id}?expand[]=invoice_settings.default_payment_method"
            ))
            .await
            .ok()?;
        let card = &v["invoice_settings"]["default_payment_method"]["card"];
        card.is_object().then(|| card.clone())
    }

    pub async fn refund(
        &self,
        payment_intent: &str,
        idempotency_key: &str,
    ) -> Result<Value, AppError> {
        let form = [("payment_intent", payment_intent.to_owned())];
        self.post("/refunds", &form, Some(idempotency_key)).await
    }

    pub fn verify_webhook(&self, payload: &[u8], signature_header: &str) -> Result<(), AppError> {
        let secret = self.webhook_secret.as_deref().ok_or_else(unavailable)?;
        verify_signature(
            secret,
            payload,
            signature_header,
            chrono::Utc::now().timestamp(),
        )
    }
}

/// Stripe ids are `prefix_` + alphanumerics; validating them prevents path
/// manipulation when we interpolate ids into API URLs.
fn is_stripe_id(id: &str, prefix: &str) -> bool {
    id.starts_with(prefix)
        && id.len() <= 255
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Verify a `Stripe-Signature` header (`t=...,v1=...`) per Stripe's scheme:
/// HMAC-SHA256(secret, "{t}.{payload}") compared in constant time, with a
/// replay-protection tolerance on `t`.
pub fn verify_signature(
    secret: &str,
    payload: &[u8],
    header: &str,
    now: i64,
) -> Result<(), AppError> {
    let invalid = || AppError::bad_request("Invalid webhook signature.");
    let mut timestamp = None;
    let mut signatures = Vec::new();
    for part in header.split(',') {
        if let Some((k, v)) = part.trim().split_once('=') {
            match k {
                "t" => timestamp = v.parse::<i64>().ok(),
                "v1" => signatures.push(v),
                _ => {}
            }
        }
    }
    let ts = timestamp.ok_or_else(invalid)?;
    if (now - ts).abs() > SIGNATURE_TOLERANCE_SECS {
        return Err(invalid());
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| invalid())?;
    mac.update(ts.to_string().as_bytes());
    mac.update(b".");
    mac.update(payload);
    let expected = hex::encode(mac.finalize().into_bytes());
    if signatures.iter().any(|s| constant_time_eq(s, &expected)) {
        Ok(())
    } else {
        Err(invalid())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(secret: &str, ts: i64, body: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(format!("{ts}.").as_bytes());
        mac.update(body);
        format!("t={ts},v1={}", hex::encode(mac.finalize().into_bytes()))
    }

    #[test]
    fn accepts_valid_and_rejects_invalid_signatures() {
        let body = br#"{"id":"evt_1"}"#;
        let header = sign("whsec_test", 1_000, body);
        assert!(verify_signature("whsec_test", body, &header, 1_010).is_ok());
        assert!(verify_signature("whsec_other", body, &header, 1_010).is_err());
        assert!(verify_signature("whsec_test", b"{}", &header, 1_010).is_err());
        // replay outside tolerance
        assert!(verify_signature("whsec_test", body, &header, 2_000).is_err());
        assert!(verify_signature("whsec_test", body, "garbage", 1_010).is_err());
    }

    #[test]
    fn validates_ids() {
        assert!(is_stripe_id("cs_test_a1B2", "cs_"));
        assert!(!is_stripe_id("cs_../../customers", "cs_"));
        assert!(!is_stripe_id("sub_123", "cs_"));
    }
}
