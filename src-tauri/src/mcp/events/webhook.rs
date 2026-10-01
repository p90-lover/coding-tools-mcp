//! Standard Webhooks signing (https://www.standardwebhooks.com/) for MCP event callbacks.
//! The secret never leaves this module in logs or errors; only its signature does.
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

const PREFIX: &str = "whsec_";
/// MCP Events require a signing key of 24–64 decoded bytes.
const MIN_KEY_BYTES: usize = 24;
const MAX_KEY_BYTES: usize = 64;

#[derive(Clone)]
pub struct WebhookSecret {
    key: Vec<u8>,
}

impl std::fmt::Debug for WebhookSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WebhookSecret([REDACTED])")
    }
}

impl WebhookSecret {
    /// Parse a `whsec_<base64>` secret. The error text never echoes the secret.
    pub fn parse(secret: &str) -> Result<Self, String> {
        let encoded = secret
            .strip_prefix(PREFIX)
            .ok_or_else(|| "delivery.secret must start with whsec_".to_string())?;
        let key = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "delivery.secret is not valid base64".to_string())?;
        if !(MIN_KEY_BYTES..=MAX_KEY_BYTES).contains(&key.len()) {
            return Err(format!(
                "delivery.secret must decode to {MIN_KEY_BYTES}-{MAX_KEY_BYTES} bytes"
            ));
        }
        Ok(Self { key })
    }

    /// `v1,<base64(HMAC-SHA256(key, "{id}.{timestamp}.{body}"))>`
    pub fn sign(&self, message_id: &str, timestamp: i64, body: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key)
            .expect("HMAC-SHA256 accepts keys of any length");
        mac.update(message_id.as_bytes());
        mac.update(b".");
        mac.update(timestamp.to_string().as_bytes());
        mac.update(b".");
        mac.update(body.as_bytes());
        let signature =
            base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        format!("v1,{signature}")
    }

    /// A stable, non-reversible fingerprint used to detect a rotated secret.
    pub fn fingerprint(&self) -> String {
        use sha2::Digest;
        let digest = Sha256::digest(&self.key);
        digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

/// Headers for one signed POST. A fresh timestamp and signature are produced per attempt.
pub fn signed_headers(
    secret: &WebhookSecret,
    message_id: &str,
    subscription_id: &str,
    timestamp: i64,
    body: &str,
) -> Vec<(&'static str, String)> {
    vec![
        ("content-type", "application/json".to_string()),
        ("webhook-id", message_id.to_string()),
        ("webhook-timestamp", timestamp.to_string()),
        (
            "webhook-signature",
            secret.sign(message_id, timestamp, body),
        ),
        ("x-mcp-subscription-id", subscription_id.to_string()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    // Official vector from standard-webhooks/libraries/rust/src/lib.rs (test_sign).
    #[test]
    fn signs_the_standard_webhooks_reference_vector() {
        let secret = WebhookSecret::parse("whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD").unwrap();
        assert_eq!(
            secret.sign(
                "msg_27UH4WbU6Z5A5EzD8u03UvzRbpk",
                1649367553,
                r#"{"email":"test@example.com","username":"test_user"}"#,
            ),
            "v1,tZ1I4/hDygAJgO5TYxiSd6Sd0kDW6hPenDe+bTa3Kkw="
        );
    }

    #[test]
    fn rejects_secrets_outside_the_mcp_events_contract() {
        assert!(WebhookSecret::parse("C2FVsBQIhrscChlQIMV+b5sSYspob7oD").is_err());
        assert!(WebhookSecret::parse("whsec_not base64!").is_err());
        // 16 decoded bytes: too short for MCP Events.
        assert!(WebhookSecret::parse("whsec_AAAAAAAAAAAAAAAAAAAAAA==").is_err());
        let long = base64::engine::general_purpose::STANDARD.encode([7u8; 65]);
        assert!(WebhookSecret::parse(&format!("whsec_{long}")).is_err());
        let max = base64::engine::general_purpose::STANDARD.encode([7u8; 64]);
        assert!(WebhookSecret::parse(&format!("whsec_{max}")).is_ok());
    }

    #[test]
    fn errors_and_debug_output_never_contain_the_secret() {
        let raw = "whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD";
        let secret = WebhookSecret::parse(raw).unwrap();
        assert!(!format!("{secret:?}").contains("C2FV"));
        let error = WebhookSecret::parse("whsec_C2FVsBQIhrscChlQ").unwrap_err();
        assert!(!error.contains("C2FV"));
    }

    #[test]
    fn signed_headers_carry_the_subscription_and_message_identity() {
        let secret = WebhookSecret::parse("whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD").unwrap();
        let headers = signed_headers(&secret, "evt_1", "sub_1", 1649367553, "{}");
        let get = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| *key == name)
                .unwrap()
                .1
                .clone()
        };
        assert_eq!(get("webhook-id"), "evt_1");
        assert_eq!(get("webhook-timestamp"), "1649367553");
        assert_eq!(get("x-mcp-subscription-id"), "sub_1");
        assert_eq!(
            get("webhook-signature"),
            secret.sign("evt_1", 1649367553, "{}")
        );
    }
}
