//! Password hashing (Argon2id), opaque tokens, HMAC signing and JWTs.

use std::sync::OnceLock;

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::Utc;
use hmac::{Hmac, Mac};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Copy)]
pub struct Argon2Params {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

fn hasher(p: Argon2Params) -> anyhow::Result<Argon2<'static>> {
    let params = Params::new(p.m_cost_kib, p.t_cost, p.p_cost, None)
        .map_err(|e| anyhow::anyhow!("invalid argon2 params: {e}"))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

fn hash_sync(password: &str, p: Argon2Params) -> anyhow::Result<String> {
    // Unique random salt per password; it is embedded in the PHC string.
    let salt = SaltString::generate(&mut OsRng);
    let hash = hasher(p)?
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("argon2 hash failed: {e}"))?;
    Ok(hash.to_string())
}

/// Hash on the blocking pool so Argon2's deliberate cost never stalls the async runtime.
pub async fn hash_password(password: String, p: Argon2Params) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || hash_sync(&password, p)).await?
}

static DUMMY_HASH: OnceLock<String> = OnceLock::new();

/// Verify a password. When `hash` is `None` (unknown email) we still burn an
/// Argon2 verification against a dummy hash so response time doesn't reveal
/// whether the account exists.
pub async fn verify_password(
    password: String,
    hash: Option<String>,
    p: Argon2Params,
) -> anyhow::Result<bool> {
    tokio::task::spawn_blocking(move || {
        let (stored, real) = match hash {
            Some(h) => (h, true),
            None => (
                DUMMY_HASH
                    .get_or_init(|| hash_sync("dummy-password-for-timing", p).unwrap_or_default())
                    .clone(),
                false,
            ),
        };
        let parsed = PasswordHash::new(&stored)
            .map_err(|e| anyhow::anyhow!("stored hash is not a valid PHC string: {e}"))?;
        // Parameters are read from the PHC string, so raising costs later
        // doesn't invalidate existing hashes.
        let ok = Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok();
        Ok(ok && real)
    })
    .await?
}

/// Pre-compute the dummy hash at startup so the first failed login isn't slower.
pub fn warm_up(p: Argon2Params) {
    tokio::task::spawn_blocking(move || {
        DUMMY_HASH.get_or_init(|| hash_sync("dummy-password-for-timing", p).unwrap_or_default());
    });
}

/// 256 bits of OS randomness, URL-safe base64.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn sha256_hex(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

fn mac(key: &[u8]) -> HmacSha256 {
    HmacSha256::new_from_slice(key).expect("HMAC accepts keys of any length")
}

/// Guest session token: `<uuid>.<base64url(HMAC(key, "guest:" + uuid))>`.
pub fn sign_guest(key: &[u8], id: Uuid) -> String {
    let mut m = mac(key);
    m.update(b"guest:");
    m.update(id.to_string().as_bytes());
    format!("{id}.{}", URL_SAFE_NO_PAD.encode(m.finalize().into_bytes()))
}

pub fn verify_guest(key: &[u8], token: &str) -> Option<Uuid> {
    let (id_part, sig_part) = token.split_once('.')?;
    let id = Uuid::parse_str(id_part).ok()?;
    let sig = URL_SAFE_NO_PAD.decode(sig_part).ok()?;
    let mut m = mac(key);
    m.update(b"guest:");
    m.update(id.to_string().as_bytes());
    m.verify_slice(&sig).ok()?;
    Some(id)
}

/// Keyed hash of a client IP so we can correlate sessions without storing raw IPs.
pub fn hash_ip(key: &[u8], ip: &str) -> String {
    let mut m = mac(key);
    m.update(b"ip:");
    m.update(ip.as_bytes());
    hex::encode(&m.finalize().into_bytes()[..16])
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AccessClaims {
    pub sub: Uuid,
    pub sid: Uuid,
    pub iat: i64,
    pub exp: i64,
    pub typ: String,
}

pub fn issue_access_token(
    secret: &[u8],
    user_id: Uuid,
    session_id: Uuid,
    ttl_secs: i64,
) -> anyhow::Result<String> {
    let now = Utc::now().timestamp();
    let claims = AccessClaims {
        sub: user_id,
        sid: session_id,
        iat: now,
        exp: now + ttl_secs,
        typ: "access".into(),
    };
    Ok(encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret),
    )?)
}

pub fn decode_access_token(secret: &[u8], token: &str) -> Option<AccessClaims> {
    let mut validation = Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.leeway = 5;
    validation.set_required_spec_claims(&["exp", "sub"]);
    let data =
        decode::<AccessClaims>(token, &DecodingKey::from_secret(secret), &validation).ok()?;
    (data.claims.typ == "access").then_some(data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"test-key-test-key-test-key-test-key";

    #[test]
    fn guest_token_roundtrip_and_tamper() {
        let id = Uuid::new_v4();
        let token = sign_guest(KEY, id);
        assert_eq!(verify_guest(KEY, &token), Some(id));

        let other = Uuid::new_v4();
        let forged = format!("{other}.{}", token.split_once('.').unwrap().1);
        assert_eq!(verify_guest(KEY, &forged), None);
        assert_eq!(
            verify_guest(b"another-key-another-key-another-key", &token),
            None
        );
        assert_eq!(verify_guest(KEY, "garbage"), None);
    }

    #[test]
    fn jwt_roundtrip() {
        let (uid, sid) = (Uuid::new_v4(), Uuid::new_v4());
        let token = issue_access_token(KEY, uid, sid, 60).unwrap();
        let claims = decode_access_token(KEY, &token).unwrap();
        assert_eq!((claims.sub, claims.sid), (uid, sid));
        assert!(decode_access_token(b"wrong-key-wrong-key-wrong-key-wrong", &token).is_none());
        let expired = issue_access_token(KEY, uid, sid, -120).unwrap();
        assert!(decode_access_token(KEY, &expired).is_none());
    }

    #[tokio::test]
    async fn argon2id_hash_and_verify() {
        let p = Argon2Params {
            m_cost_kib: 19 * 1024,
            t_cost: 2,
            p_cost: 1,
        };
        let hash = hash_password("correct horse battery".into(), p)
            .await
            .unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(
            verify_password("correct horse battery".into(), Some(hash.clone()), p)
                .await
                .unwrap()
        );
        assert!(!verify_password("wrong".into(), Some(hash), p)
            .await
            .unwrap());
        assert!(!verify_password("anything".into(), None, p).await.unwrap());
    }

    #[test]
    fn tokens_are_unique_and_long() {
        let a = random_token();
        assert_ne!(a, random_token());
        assert!(a.len() >= 43);
    }
}
