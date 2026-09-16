use crate::{
    data::DataStore,
    error::{AppError, AppResult},
    providers::{ProviderCapability, ProviderProfile, ProviderProtocol},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::Url;

const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMAGES: u8 = 4;

fn fail(message: impl Into<String>) -> AppError {
    AppError::Message(message.into())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn bounded(value: &str, max: usize, label: &str, required: bool) -> AppResult<()> {
    if (required && value.trim().is_empty())
        || value.len() > max
        || value
            .chars()
            .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        return Err(fail(format!("Invalid {label}")));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageGenerationTarget {
    Paseo,
    Anneal,
    Direct,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageGenerationInput {
    pub workspace_id: String,
    pub provider_profile_id: String,
    pub credential: String,
    pub target: ImageGenerationTarget,
    pub model: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub size: Option<String>,
    pub aspect_ratio: Option<String>,
    #[serde(default = "default_count")]
    pub count: u8,
}

fn default_count() -> u8 {
    1
}

#[derive(Clone, Debug, Serialize)]
pub struct ImageArtifact {
    pub id: String,
    pub absolute_path: String,
    pub relative_path: String,
    pub media_type: String,
    pub byte_length: usize,
    pub revised_prompt: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ImageGenerationResult {
    pub request_id: String,
    pub workspace_id: String,
    pub provider_profile_id: String,
    pub provider_name: String,
    pub model: String,
    pub target: ImageGenerationTarget,
    pub created_at: u64,
    pub artifacts: Vec<ImageArtifact>,
    pub manifest_path: String,
}

#[derive(Clone, Debug)]
enum ProviderImage {
    Base64 {
        media_type: Option<String>,
        data: String,
        revised_prompt: Option<String>,
    },
    Url {
        url: String,
        revised_prompt: Option<String>,
    },
}

fn validate_target(profile: &ProviderProfile, target: ImageGenerationTarget) -> AppResult<()> {
    if !profile.enabled || profile.archived {
        return Err(fail("Provider profile is disabled"));
    }
    if !profile.image_enabled
        || !profile
            .capabilities
            .contains(&ProviderCapability::ImageGeneration)
    {
        return Err(fail("Provider profile is not admitted for image_generation"));
    }
    let allowed = match target {
        ImageGenerationTarget::Paseo => profile.paseo_enabled,
        ImageGenerationTarget::Anneal => profile.anneal_enabled,
        ImageGenerationTarget::Direct => profile.direct_enabled,
    };
    if !allowed {
        return Err(fail("Provider profile is not admitted for the selected engine"));
    }
    Ok(())
}

fn endpoint(profile: &ProviderProfile, model: &str) -> AppResult<Url> {
    let base = profile
        .base_url
        .as_deref()
        .ok_or_else(|| fail("Configure a provider base URL before generating an image"))?;
    let mut url = Url::parse(base).map_err(|_| fail("Provider base URL is invalid"))?;
    let suffix = match profile.protocol {
        ProviderProtocol::OpenAiChat => "chat/completions".to_string(),
        ProviderProtocol::OpenAiResponses | ProviderProtocol::ImageApi => {
            "images/generations".to_string()
        }
        ProviderProtocol::GeminiNative => {
            format!("models/{}:generateContent", model.trim_start_matches("models/"))
        }
        ProviderProtocol::AnthropicMessages => {
            return Err(fail("Anthropic Messages does not expose image output generation"));
        }
    };
    let base_path = url.path().trim_end_matches('/');
    url.set_path(&format!("{base_path}/{suffix}"));
    Ok(url)
}

fn headers(profile: &ProviderProfile, credential: &str) -> AppResult<HeaderMap> {
    if credential.len() > 8_192 || credential.chars().any(char::is_control) {
        return Err(fail("Provider credential is invalid"));
    }
    let mut headers = HeaderMap::new();
    headers.insert("accept", HeaderValue::from_static("application/json"));
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    if credential.is_empty() {
        return Ok(headers);
    }
    match profile.protocol {
        ProviderProtocol::GeminiNative => {
            headers.insert(
                "x-goog-api-key",
                HeaderValue::from_str(credential)
                    .map_err(|_| fail("Provider credential cannot be encoded"))?,
            );
        }
        _ => {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {credential}"))
                    .map_err(|_| fail("Provider credential cannot be encoded"))?,
            );
        }
    }
    Ok(headers)
}

fn request_body(profile: &ProviderProfile, input: &ImageGenerationInput) -> Value {
    let prompt = if let Some(negative) = input
        .negative_prompt
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        format!("{}\n\nAvoid: {}", input.prompt, negative)
    } else {
        input.prompt.clone()
    };
    match profile.protocol {
        ProviderProtocol::OpenAiChat => json!({
            "model": input.model,
            "messages": [{"role": "user", "content": prompt}],
            "n": input.count,
            "stream": false,
            "response_format": {"type": "image"},
            "size": input.size,
            "aspect_ratio": input.aspect_ratio,
        }),
        ProviderProtocol::OpenAiResponses | ProviderProtocol::ImageApi => json!({
            "model": input.model,
            "prompt": prompt,
            "n": input.count,
            "response_format": "b64_json",
            "size": input.size,
            "aspect_ratio": input.aspect_ratio,
        }),
        ProviderProtocol::GeminiNative => json!({
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseModalities": ["TEXT", "IMAGE"],
                "candidateCount": input.count,
                "imageConfig": {
                    "aspectRatio": input.aspect_ratio,
                    "imageSize": input.size,
                }
            }
        }),
        ProviderProtocol::AnthropicMessages => Value::Null,
    }
}

async fn read_limited(mut response: reqwest::Response, limit: usize) -> AppResult<Vec<u8>> {
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Err(fail("Provider response exceeds the allowed size"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| fail(format!("Could not read provider response: {error}")))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(fail("Provider response exceeds the allowed size"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn data_url(value: &str) -> Option<(String, String)> {
    let value = value.strip_prefix("data:")?;
    let (metadata, data) = value.split_once(',')?;
    let media_type = metadata.strip_suffix(";base64")?;
    if media_type.is_empty() || data.is_empty() {
        return None;
    }
    Some((media_type.to_string(), data.to_string()))
}

fn collect_parts(value: &Value, output: &mut Vec<ProviderImage>, revised_prompt: Option<String>) {
    if output.len() >= MAX_IMAGES as usize {
        return;
    }
    if let Some(data) = value.get("b64_json").and_then(Value::as_str) {
        output.push(ProviderImage::Base64 {
            media_type: value
                .get("mime_type")
                .or_else(|| value.get("mimeType"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            data: data.to_string(),
            revised_prompt,
        });
        return;
    }
    for key in ["inlineData", "inline_data"] {
        if let Some(inline) = value.get(key) {
            if let Some(data) = inline.get("data").and_then(Value::as_str) {
                output.push(ProviderImage::Base64 {
                    media_type: inline
                        .get("mimeType")
                        .or_else(|| inline.get("mime_type"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    data: data.to_string(),
                    revised_prompt,
                });
                return;
            }
        }
    }
    if let Some(url) = value
        .get("image_url")
        .and_then(|entry| entry.get("url").or(Some(entry)))
        .and_then(Value::as_str)
        .or_else(|| value.get("url").and_then(Value::as_str))
    {
        if let Some((media_type, data)) = data_url(url) {
            output.push(ProviderImage::Base64 {
                media_type: Some(media_type),
                data,
                revised_prompt,
            });
        } else {
            output.push(ProviderImage::Url {
                url: url.to_string(),
                revised_prompt,
            });
        }
    }
}

fn collect_images(value: &Value) -> Vec<ProviderImage> {
    let mut output = Vec::new();
    if let Some(data) = value.get("data").and_then(Value::as_array) {
        for item in data {
            let revised = item
                .get("revised_prompt")
                .and_then(Value::as_str)
                .map(str::to_owned);
            collect_parts(item, &mut output, revised);
        }
    }
    if let Some(images) = value.get("images").and_then(Value::as_array) {
        for item in images {
            collect_parts(item, &mut output, None);
        }
    }
    if let Some(candidates) = value.get("candidates").and_then(Value::as_array) {
        for candidate in candidates {
            if let Some(parts) = candidate
                .get("content")
                .and_then(|content| content.get("parts"))
                .and_then(Value::as_array)
            {
                for part in parts {
                    collect_parts(part, &mut output, None);
                }
            }
        }
    }
    if let Some(choices) = value.get("choices").and_then(Value::as_array) {
        for choice in choices {
            if let Some(content) = choice
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_array)
            {
                for part in content {
                    collect_parts(part, &mut output, None);
                }
            }
        }
    }
    output.truncate(MAX_IMAGES as usize);
    output
}

fn allowed_remote_image_url(value: &str) -> AppResult<Url> {
    let url = Url::parse(value).map_err(|_| fail("Provider returned an invalid image URL"))?;
    let loopback = match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(fail(
            "Generated image URLs require HTTPS or an explicit loopback HTTP host",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(fail("Generated image URL must not contain credentials"));
    }
    Ok(url)
}

fn media_type_and_extension(bytes: &[u8], claimed: Option<&str>) -> AppResult<(String, &'static str)> {
    let format = image::guess_format(bytes).map_err(|_| fail("Provider output is not a supported image"))?;
    let (media_type, extension) = match format {
        image::ImageFormat::Png => ("image/png", "png"),
        image::ImageFormat::Jpeg => ("image/jpeg", "jpg"),
        image::ImageFormat::WebP => ("image/webp", "webp"),
        image::ImageFormat::Gif => ("image/gif", "gif"),
        _ => return Err(fail("Provider output uses an unsupported image format")),
    };
    if claimed.is_some_and(|value| !value.eq_ignore_ascii_case(media_type)) {
        return Err(fail("Provider image media type does not match its bytes"));
    }
    Ok((media_type.to_string(), extension))
}

fn workspace_root(workspace_id: &str) -> AppResult<PathBuf> {
    bounded(workspace_id, 128, "workspace ID", true)?;
    DataStore::read_file(|data| {
        let workspace = data
            .profiles
            .iter()
            .find(|profile| profile.id == workspace_id)
            .ok_or_else(|| fail("Workspace not found"))?;
        PathBuf::from(&workspace.path)
            .canonicalize()
            .map_err(|_| fail("Workspace path is unavailable"))
    })
}

fn create_new(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| fail(format!("Could not create image artifact: {error}")))?;
    file.write_all(bytes)
        .map_err(|error| fail(format!("Could not write image artifact: {error}")))?;
    file.sync_all()
        .map_err(|error| fail(format!("Could not sync image artifact: {error}")))
}

pub async fn generate(input: ImageGenerationInput) -> AppResult<ImageGenerationResult> {
    bounded(&input.provider_profile_id, 128, "provider profile ID", true)?;
    bounded(&input.model, 256, "image model", true)?;
    bounded(&input.prompt, 32_768, "image prompt", true)?;
    if let Some(negative) = &input.negative_prompt {
        bounded(negative, 8_192, "negative prompt", false)?;
    }
    if !(1..=MAX_IMAGES).contains(&input.count) {
        return Err(fail("Image count must be 1..4"));
    }
    let profile = DataStore::read_file(|data| {
        data.provider_profiles
            .iter()
            .find(|profile| profile.id == input.provider_profile_id)
            .cloned()
            .ok_or_else(|| fail("Provider profile not found"))
    })?;
    validate_target(&profile, input.target)?;
    if !profile.models.is_empty() && !profile.models.iter().any(|model| model == &input.model) {
        return Err(fail("Image model is not in the provider's discovered catalogue"));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| fail("Image provider client unavailable"))?;
    let response = client
        .post(endpoint(&profile, &input.model)?)
        .headers(headers(&profile, &input.credential)?)
        .json(&request_body(&profile, &input))
        .send()
        .await
        .map_err(|error| fail(format!("Image provider request failed: {error}")))?;
    let status = response.status();
    let response_bytes = read_limited(response, MAX_JSON_BYTES).await?;
    let payload: Value = serde_json::from_slice(&response_bytes)
        .map_err(|_| fail("Image provider returned invalid JSON"))?;
    if !status.is_success() {
        let message = payload
            .get("error")
            .and_then(|error| error.get("message").or(Some(error)))
            .and_then(Value::as_str)
            .or_else(|| payload.get("message").and_then(Value::as_str))
            .unwrap_or("Image provider rejected the request");
        return Err(fail(format!("Image provider returned HTTP {}: {message}", status.as_u16())));
    }
    let candidates = collect_images(&payload);
    if candidates.is_empty() {
        return Err(fail("Image provider response did not contain an image"));
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let created_at = now();
    let root = workspace_root(&input.workspace_id)?;
    let relative_root = PathBuf::from(".coding-tools")
        .join("artifacts")
        .join(&request_id)
        .join("images");
    let artifact_root = root.join(&relative_root);
    fs::create_dir_all(&artifact_root)
        .map_err(|error| fail(format!("Could not create artifact directory: {error}")))?;

    let mut artifacts = Vec::new();
    for (index, candidate) in candidates.into_iter().enumerate() {
        let (bytes, claimed, revised_prompt) = match candidate {
            ProviderImage::Base64 {
                media_type,
                data,
                revised_prompt,
            } => {
                let decoded = STANDARD
                    .decode(data.as_bytes())
                    .map_err(|_| fail("Image provider returned invalid base64"))?;
                if decoded.len() > MAX_IMAGE_BYTES {
                    return Err(fail("Generated image exceeds 32 MiB"));
                }
                (decoded, media_type, revised_prompt)
            }
            ProviderImage::Url { url, revised_prompt } => {
                let response = client
                    .get(allowed_remote_image_url(&url)?)
                    .send()
                    .await
                    .map_err(|error| fail(format!("Could not download generated image: {error}")))?;
                if !response.status().is_success() {
                    return Err(fail(format!(
                        "Generated image download returned HTTP {}",
                        response.status().as_u16()
                    )));
                }
                let claimed = response
                    .headers()
                    .get("content-type")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.split(';').next())
                    .map(str::to_owned);
                (
                    read_limited(response, MAX_IMAGE_BYTES).await?,
                    claimed,
                    revised_prompt,
                )
            }
        };
        let (media_type, extension) = media_type_and_extension(&bytes, claimed.as_deref())?;
        let filename = format!("{:03}.{extension}", index + 1);
        let absolute_path = artifact_root.join(&filename);
        create_new(&absolute_path, &bytes)?;
        artifacts.push(ImageArtifact {
            id: format!("{}-{:03}", request_id, index + 1),
            absolute_path: absolute_path.to_string_lossy().into_owned(),
            relative_path: relative_root.join(&filename).to_string_lossy().into_owned(),
            media_type,
            byte_length: bytes.len(),
            revised_prompt,
        });
    }

    let manifest_path = artifact_root.join("manifest.json");
    let result = ImageGenerationResult {
        request_id,
        workspace_id: input.workspace_id,
        provider_profile_id: profile.id,
        provider_name: profile.name,
        model: input.model,
        target: input.target,
        created_at,
        artifacts,
        manifest_path: manifest_path.to_string_lossy().into_owned(),
    };
    let manifest = serde_json::to_vec_pretty(&json!({
        "schema": 1,
        "request_id": result.request_id,
        "workspace_id": result.workspace_id,
        "provider_profile_id": result.provider_profile_id,
        "provider_name": result.provider_name,
        "model": result.model,
        "target": result.target,
        "created_at": result.created_at,
        "prompt": input.prompt,
        "negative_prompt": input.negative_prompt,
        "size": input.size,
        "aspect_ratio": input.aspect_ratio,
        "artifacts": result.artifacts,
    }))
    .map_err(|_| fail("Could not serialize image manifest"))?;
    create_new(&manifest_path, &manifest)?;
    Ok(result)
}

#[cfg(test)]
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
