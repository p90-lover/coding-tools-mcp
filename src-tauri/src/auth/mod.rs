mod bearer;
pub(crate) mod http_security;
mod oauth;
mod oauth_flow;
mod oauth_resource_metadata;
mod redirects;
mod refresh_tokens;
pub use redirects::{default_oauth_redirect_uris, validate_redirect_uris};

pub use bearer::verify_bearer_header;
pub use oauth::{authorization_server_metadata, external_base_url, protected_resource_metadata};
pub use oauth_flow::{
    authorize_get, authorize_post_browser, token_exchange, verify_oauth_bearer_header,
    AuthorizeForm, AuthorizeParams, OAuthRuntime, TokenForm,
};

pub(crate) use oauth::{sync_trusted_origins, trusted_external_base_url};
pub(crate) use oauth_resource_metadata::mcp_protected_resource_metadata;

#[cfg(test)]
#[path = "../../../aiTemp/oauth-popup/origin_policy.rs"]
mod oauth_popup_origin_policy;

#[cfg(test)]
#[path = "../../../aiTemp/oauth-prm/rfc9728_path_contract.rs"]
mod oauth_prm_path_contract;
