//! Background email delivery. Handlers enqueue and return immediately; a worker
//! task delivers via Resend's HTTP API (swap for SES/Postmark as needed).
//! Without an API key, development builds log the message instead.

use std::sync::Arc;

use serde_json::json;
use tokio::sync::mpsc;

use crate::config::Config;

pub struct Email {
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
}

#[derive(Clone)]
pub struct Mailer {
    tx: mpsc::Sender<Email>,
}

impl Mailer {
    pub fn spawn(http: reqwest::Client, config: Arc<Config>) -> Self {
        let (tx, mut rx) = mpsc::channel::<Email>(1024);
        tokio::spawn(async move {
            while let Some(email) = rx.recv().await {
                if let Err(err) = deliver(&http, &config, &email).await {
                    tracing::warn!(error = %err, subject = %email.subject, "email delivery failed");
                }
            }
        });
        Self { tx }
    }

    pub fn send(&self, email: Email) {
        if let Err(err) = self.tx.try_send(email) {
            tracing::error!(error = %err, "email queue full or closed; message dropped");
        }
    }
}

async fn deliver(http: &reqwest::Client, config: &Config, email: &Email) -> anyhow::Result<()> {
    let Some(key) = config.resend_api_key.as_deref() else {
        if config.is_production() {
            tracing::warn!(subject = %email.subject, "RESEND_API_KEY not set; email not sent");
        } else {
            tracing::info!(to = %email.to, subject = %email.subject, body = %email.text, "dev email (not sent)");
        }
        return Ok(());
    };
    let res = http
        .post("https://api.resend.com/emails")
        .bearer_auth(key)
        .json(&json!({
            "from": config.email_from,
            "to": [email.to],
            "subject": email.subject,
            "text": email.text,
            "html": email.html,
        }))
        .send()
        .await?;
    if !res.status().is_success() {
        anyhow::bail!("email provider returned {}", res.status());
    }
    Ok(())
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Simple transactional email with a single call-to-action link.
pub fn action_email(to: &str, subject: &str, intro: &str, cta: &str, link: &str) -> Email {
    let html = format!(
        r#"<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111827">
<p style="font-size:18px;font-weight:700;color:#2E3A8C;margin:0 0 16px">bizinvoX.com</p>
<p style="line-height:1.6">{intro}</p>
<p><a href="{link}" style="display:inline-block;background:#2E3A8C;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">{cta}</a></p>
<p style="color:#6B7280;font-size:13px">If you didn't request this, you can ignore this email.</p></div>"#,
        intro = escape_html(intro),
        cta = escape_html(cta),
        link = escape_html(link),
    );
    Email {
        to: to.to_owned(),
        subject: subject.to_owned(),
        text: format!(
            "{intro}\n\n{cta}: {link}\n\nIf you didn't request this, you can ignore this email."
        ),
        html,
    }
}
