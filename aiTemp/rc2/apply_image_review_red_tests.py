from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MEDIA = ROOT / "src-tauri/src/media.rs"
CONTRACT = ROOT / "aiTemp/rc2/image_provider_contract.py"


def replace_once(path: Path, old: str, new: str, label: str) -> bool:
    text = path.read_text(encoding="utf-8")
    if new in text and old not in text:
        return False
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


old_tests = '''#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openai_and_gemini_image_shapes() {
        let openai = json!({"data":[{"b64_json":"AA==","revised_prompt":"revised"}]});
        let gemini = json!({"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"AA=="}}]}}]});
        assert_eq!(collect_images(&openai).len(), 1);
        assert_eq!(collect_images(&gemini).len(), 1);
    }

    #[test]
    fn rejects_remote_plain_http_image_urls() {
        assert!(allowed_remote_image_url("http://example.com/image.png").is_err());
        assert!(allowed_remote_image_url("http://127.0.0.1:7860/image.png").is_ok());
        assert!(allowed_remote_image_url("https://example.com/image.png").is_ok());
    }
}
'''

new_tests = '''#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{ProviderAuth, ProviderCategory};

    fn profile(auth: ProviderAuth, protocol: ProviderProtocol) -> ProviderProfile {
        ProviderProfile {
            id: "image-test".into(),
            name: "Image test".into(),
            template_id: "image-test".into(),
            category: ProviderCategory::ReverseProxy,
            auth,
            protocol,
            base_url: Some("http://127.0.0.1:7860/v1".into()),
            models_endpoint: Some("/models".into()),
            models: vec!["image-model".into()],
            capabilities: vec![ProviderCapability::ImageGeneration],
            paseo_enabled: true,
            anneal_enabled: true,
            direct_enabled: true,
            image_enabled: true,
            priority: 1,
            enabled: true,
            archived: false,
            generation: "generation-1".into(),
            revision: 0,
            updated_at: 0,
        }
    }

    fn input(size: Option<&str>, aspect_ratio: Option<&str>) -> ImageGenerationInput {
        ImageGenerationInput {
            workspace_id: "workspace".into(),
            provider_profile_id: "image-test".into(),
            credential: "secret".into(),
            target: ImageGenerationTarget::Direct,
            model: "image-model".into(),
            prompt: "draw a test image".into(),
            negative_prompt: None,
            size: size.map(str::to_owned),
            aspect_ratio: aspect_ratio.map(str::to_owned),
            count: 1,
        }
    }

    #[test]
    fn parses_openai_and_gemini_image_shapes() {
        let openai = json!({"data":[{"b64_json":"AA==","revised_prompt":"revised"}]});
        let gemini = json!({"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"AA=="}}]}}]});
        assert_eq!(collect_images(&openai).len(), 1);
        assert_eq!(collect_images(&gemini).len(), 1);
    }

    #[test]
    fn parses_string_valued_chat_image_content() {
        let chat = json!({
            "choices": [{
                "message": {
                    "content": "data:image/png;base64,AA=="
                }
            }]
        });
        assert_eq!(collect_images(&chat).len(), 1);
    }

    #[test]
    fn maps_openai_dimensions_to_gemini_symbolic_size() {
        let body = request_body(
            &profile(ProviderAuth::ApiKey, ProviderProtocol::GeminiNative),
            &input(Some("1024x1024"), Some("1:1")),
        );
        assert_eq!(
            body.pointer("/generationConfig/imageConfig/imageSize"),
            Some(&Value::String("1K".into()))
        );
    }

    #[test]
    fn omits_unsupported_aspect_ratio_from_openai_image_request() {
        let body = request_body(
            &profile(ProviderAuth::ApiKey, ProviderProtocol::OpenAiResponses),
            &input(Some("1024x1024"), Some("1:1")),
        );
        assert!(body.get("aspect_ratio").is_none());
    }

    #[test]
    fn gemini_local_proxy_uses_bearer_and_compatibility_key_headers() {
        let headers = headers(
            &profile(ProviderAuth::LocalProxy, ProviderProtocol::GeminiNative),
            "secret",
        )
        .expect("headers");
        assert_eq!(
            headers
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer secret")
        );
        assert_eq!(
            headers
                .get("x-goog-api-key")
                .and_then(|value| value.to_str().ok()),
            Some("secret")
        );
    }

    #[test]
    fn json_response_limit_covers_all_advertised_base64_outputs() {
        let decoded = MAX_IMAGE_BYTES * MAX_IMAGES as usize;
        let encoded = 4 * decoded.div_ceil(3);
        assert!(MAX_JSON_BYTES >= encoded + 1024 * 1024);
    }

    #[test]
    fn rejects_remote_plain_http_image_urls() {
        assert!(allowed_remote_image_url("http://example.com/image.png").is_err());
        assert!(allowed_remote_image_url("http://127.0.0.1:7860/image.png").is_ok());
        assert!(allowed_remote_image_url("https://example.com/image.png").is_ok());
    }
}
'''

old_contract = '''def require(path: str, *needles: str) -> None:
    text = source(path)
    missing = [needle for needle in needles if needle not in text]
    if missing:
        raise AssertionError(f"{path} missing: {', '.join(missing)}")


def main() -> None:
'''

new_contract = '''def require(path: str, *needles: str) -> None:
    text = source(path)
    missing = [needle for needle in needles if needle not in text]
    if missing:
        raise AssertionError(f"{path} missing: {', '.join(missing)}")


def forbid(path: str, *needles: str) -> None:
    text = source(path)
    present = [needle for needle in needles if needle in text]
    if present:
        raise AssertionError(f"{path} contains forbidden text: {', '.join(present)}")


def require_before(path: str, first: str, second: str) -> None:
    text = source(path)
    first_index = text.find(first)
    second_index = text.find(second)
    if first_index < 0 or second_index < 0 or first_index >= second_index:
        raise AssertionError(f"{path} must place {first!r} before {second!r}")


def main() -> None:
'''

old_media_requirements = '''    require(
        "src-tauri/src/media.rs",
        "ImageGenerationInput",
        "ImageGenerationTarget",
        "image_generation",
        "inlineData",
        "b64_json",
        "create_new(true)",
        ".coding-tools",
        "artifacts",
    )
'''

new_media_requirements = '''    require(
        "src-tauri/src/media.rs",
        "ImageGenerationInput",
        "ImageGenerationTarget",
        "image_generation",
        "inlineData",
        "b64_json",
        "create_new(true)",
        ".coding-tools",
        "artifacts",
        "connected_credential(&profile)",
        "validate_image_dimensions",
        "preview_data_url",
    )
    require_before(
        "src-tauri/src/media.rs",
        "workspace_root(&input.workspace_id)",
        ".post(endpoint(&profile, &input.model)?",
    )
'''

old_ui_requirements = '''    require(
        "src/routes/image-studio/+page.svelte",
        "generateProviderImage",
        "image_generation",
        "paseo",
        "anneal",
    )
'''

new_ui_requirements = '''    require(
        "src/routes/image-studio/+page.svelte",
        "generateProviderImage",
        "image_generation",
        "paseo",
        "anneal",
        "profile.base_url",
        "artifact.preview_data_url",
    )
    forbid(
        "src/routes/image-studio/+page.svelte",
        "convertFileSrc",
    )
'''

changed = False
changed |= replace_once(MEDIA, old_tests, new_tests, "media review tests")
changed |= replace_once(CONTRACT, old_contract, new_contract, "contract helpers")
changed |= replace_once(CONTRACT, old_media_requirements, new_media_requirements, "media contract")
changed |= replace_once(CONTRACT, old_ui_requirements, new_ui_requirements, "ui contract")
print(f"IMAGE_REVIEW_RED_TESTS_OK changed={str(changed).lower()}")
