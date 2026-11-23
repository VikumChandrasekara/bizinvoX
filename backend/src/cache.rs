//! Redis helpers. Redis is a cache / ephemeral-state store only: every caller
//! must tolerate a miss (or an outage) and fall back to Postgres.

use std::sync::LazyLock;

use redis::{aio::ConnectionManager, RedisResult, Script};
use serde::{de::DeserializeOwned, Serialize};

/// Sliding-window-log rate limiter, atomic via Lua so concurrent requests
/// can never both slip under the limit.
static SLIDING_WINDOW: LazyLock<Script> = LazyLock::new(|| {
    Script::new(
        r#"
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
if redis.call('ZCARD', key) >= limit then
  redis.call('PEXPIRE', key, window)
  return 0
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return 1
"#,
    )
});

/// Returns `true` if the request is allowed.
pub async fn rate_limit_allow(
    conn: &ConnectionManager,
    key: &str,
    limit: u32,
    window_ms: u64,
) -> RedisResult<bool> {
    let mut conn = conn.clone();
    let now = chrono::Utc::now().timestamp_millis();
    let member = format!("{now}-{}", uuid::Uuid::new_v4().simple());
    let mut invocation = SLIDING_WINDOW.prepare_invoke();
    invocation
        .key(key)
        .arg(now)
        .arg(window_ms)
        .arg(limit)
        .arg(member);
    let allowed: i64 = invocation.invoke_async(&mut conn).await?;
    Ok(allowed == 1)
}

pub async fn get_json<T: DeserializeOwned>(conn: &ConnectionManager, key: &str) -> Option<T> {
    let mut conn = conn.clone();
    let raw: RedisResult<Option<String>> = redis::cmd("GET").arg(key).query_async(&mut conn).await;
    match raw {
        Ok(Some(s)) => serde_json::from_str(&s).ok(),
        Ok(None) => None,
        Err(err) => {
            tracing::warn!(%key, error = %err, "redis GET failed; falling back");
            None
        }
    }
}

pub async fn set_json<T: Serialize>(conn: &ConnectionManager, key: &str, value: &T, ttl_secs: u64) {
    let Ok(payload) = serde_json::to_string(value) else {
        return;
    };
    set_str(conn, key, &payload, ttl_secs).await;
}

pub async fn set_str(conn: &ConnectionManager, key: &str, value: &str, ttl_secs: u64) {
    let mut conn = conn.clone();
    let res: RedisResult<()> = redis::cmd("SET")
        .arg(key)
        .arg(value)
        .arg("EX")
        .arg(ttl_secs.max(1))
        .query_async(&mut conn)
        .await;
    if let Err(err) = res {
        tracing::warn!(%key, error = %err, "redis SET failed");
    }
}

pub async fn get_str(conn: &ConnectionManager, key: &str) -> RedisResult<Option<String>> {
    let mut conn = conn.clone();
    redis::cmd("GET").arg(key).query_async(&mut conn).await
}

/// `SET key value NX EX ttl` - returns `true` if this caller claimed the key.
pub async fn set_nx(
    conn: &ConnectionManager,
    key: &str,
    value: &str,
    ttl_secs: u64,
) -> RedisResult<bool> {
    let mut conn = conn.clone();
    let res: Option<String> = redis::cmd("SET")
        .arg(key)
        .arg(value)
        .arg("NX")
        .arg("EX")
        .arg(ttl_secs)
        .query_async(&mut conn)
        .await?;
    Ok(res.is_some())
}

/// Atomic read-and-delete (single-use tokens).
pub async fn get_del(conn: &ConnectionManager, key: &str) -> RedisResult<Option<String>> {
    let mut conn = conn.clone();
    redis::cmd("GETDEL").arg(key).query_async(&mut conn).await
}

pub async fn del(conn: &ConnectionManager, keys: &[String]) {
    if keys.is_empty() {
        return;
    }
    let mut conn = conn.clone();
    let res: RedisResult<()> = redis::cmd("DEL").arg(keys).query_async(&mut conn).await;
    if let Err(err) = res {
        tracing::warn!(error = %err, "redis DEL failed");
    }
}
