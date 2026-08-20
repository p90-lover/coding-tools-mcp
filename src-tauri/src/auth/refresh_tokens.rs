use sha2::{Digest, Sha256};

use crate::auth::bearer::constant_time_eq_str;
use crate::data::{DataStore, OAuthRefreshTokenRecord};
use crate::error::AppResult;

pub const OAUTH_REFRESH_TOKEN_TTL_SECONDS: u64 = 60 * 60 * 24 * 180;
const MAX_REFRESH_TOKENS_PER_WORKSPACE: usize = 16;

#[derive(Debug, Clone)]
pub struct RefreshTokenStore {
    profile_id: String,
}

impl RefreshTokenStore {
    pub fn new(profile_id: impl Into<String>) -> Self {
        Self {
            profile_id: profile_id.into(),
        }
    }

    pub fn issue(&self, client_id: &str, now: u64) -> AppResult<String> {
        let mut raw = String::new();
        DataStore::update_file(|data| {
            let records = data
                .oauth_refresh_tokens
                .entry(self.profile_id.clone())
                .or_default();
            raw = issue_into(records, client_id, now);
            Ok(())
        })?;
        Ok(raw)
    }

    pub fn rotate(&self, token: &str, client_id: &str, now: u64) -> AppResult<Option<String>> {
        DataStore::update_file(|data| {
            let records = data
                .oauth_refresh_tokens
                .entry(self.profile_id.clone())
                .or_default();
            Ok(rotate_in(records, token, client_id, now))
        })
    }

    pub fn revoke_all(&self) -> AppResult<()> {
        DataStore::update_file(|data| {
            data.oauth_refresh_tokens.remove(&self.profile_id);
            Ok(())
        })
    }
}

fn issue_into(records: &mut Vec<OAuthRefreshTokenRecord>, client_id: &str, now: u64) -> String {
    prune(records, now);
    let raw = random_token();
    records.push(OAuthRefreshTokenRecord {
        token_hash: hash_token(&raw),
        client_id: client_id.to_string(),
        family_id: uuid::Uuid::new_v4().to_string(),
        generation: 0,
        issued_at: now,
        expires_at: now.saturating_add(OAUTH_REFRESH_TOKEN_TTL_SECONDS),
    });
    if records.len() > MAX_REFRESH_TOKENS_PER_WORKSPACE {
        records.sort_by_key(|record| record.issued_at);
        let excess = records.len() - MAX_REFRESH_TOKENS_PER_WORKSPACE;
        records.drain(0..excess);
    }
    raw
}

fn rotate_in(
    records: &mut Vec<OAuthRefreshTokenRecord>,
    token: &str,
    client_id: &str,
    now: u64,
) -> Option<String> {
    prune(records, now);
    let incoming_hash = hash_token(token);
    let index = records.iter().position(|record| {
        constant_time_eq_str(&record.token_hash, &incoming_hash)
            && constant_time_eq_str(&record.client_id, client_id)
            && record.expires_at >= now
    })?;
    let previous = records.remove(index);
    let raw = random_token();
    records.push(OAuthRefreshTokenRecord {
        token_hash: hash_token(&raw),
        client_id: previous.client_id,
        family_id: previous.family_id,
        generation: previous.generation.saturating_add(1),
        issued_at: now,
        expires_at: now.saturating_add(OAUTH_REFRESH_TOKEN_TTL_SECONDS),
    });
    Some(raw)
}

fn prune(records: &mut Vec<OAuthRefreshTokenRecord>, now: u64) {
    records.retain(|record| record.expires_at >= now && !record.token_hash.is_empty());
}

fn random_token() -> String {
    format!(
        "rt_{}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issued_records_store_only_hashes() {
        let mut records = Vec::new();
        let token = issue_into(&mut records, "client", 10);
        assert!(token.starts_with("rt_"));
        assert_eq!(records.len(), 1);
        assert_ne!(records[0].token_hash, token);
        assert_eq!(records[0].token_hash.len(), 64);
    }

    #[test]
    fn rotation_consumes_old_token_and_rejects_replay() {
        let mut records = Vec::new();
        let token = issue_into(&mut records, "client", 10);
        let rotated = rotate_in(&mut records, &token, "client", 20).expect("rotate");
        assert_ne!(rotated, token);
        assert!(rotate_in(&mut records, &token, "client", 21).is_none());
        assert!(rotate_in(&mut records, &rotated, "client", 22).is_some());
    }

    #[test]
    fn rotation_rejects_client_mismatch_and_expiry() {
        let mut records = Vec::new();
        let token = issue_into(&mut records, "client-a", 10);
        assert!(rotate_in(&mut records, &token, "client-b", 20).is_none());
        assert!(rotate_in(
            &mut records,
            &token,
            "client-a",
            10 + OAUTH_REFRESH_TOKEN_TTL_SECONDS + 1,
        )
        .is_none());
    }
}
