from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MEDIA = ROOT / "src-tauri/src/media.rs"
PROVIDERS = ROOT / "src-tauri/src/providers.rs"
MEDIA_TYPES = ROOT / "src/lib/provider-media.ts"
PAGE = ROOT / "src/routes/image-studio/+page.svelte"


def replace_once(path: Path, old: str, new: str, label: str) -> bool:
    text = path.read_text(encoding="utf-8")
    if new in text and old not in text:
        return False
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


changed = False

changed |= replace_once(
    MEDIA,
    '''    providers::{ProviderCapability, ProviderProfile, ProviderProtocol},
''',
    '''    providers::{
        connected_credential, request_headers, ProviderCapability, ProviderProfile,
        ProviderProtocol,
    },
''',
    "media provider imports",
)
changed |= replace_once(
    MEDIA,
    '''    io::Write,
''',
    '''    io::{Cursor, Write},
''',
    "media cursor import",
)
changed |= replace_once(
    MEDIA,
    '''const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMAGES: u8 = 4;
''',
    '''const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMAGES: u8 = 4;
const MAX_ENCODED_IMAGE_BYTES: usize = 4 * MAX_IMAGE_BYTES.div_ceil(3);
const MAX_JSON_BYTES: usize = MAX_ENCODED_IMAGE_BYTES * MAX_IMAGES as usize + 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MAX_IMAGE_PIXELS: u64 = 100_000_000;
const MAX_PREVIEW_BYTES: usize = 4 * 1024 * 1024;
''',
    "media limits",
)
changed |= replace_once(
    MEDIA,
    '''    pub media_type: String,
    pub byte_length: usize,
''',
    '''    pub media_type: String,
    pub preview_data_url: Option<String>,
    pub byte_length: usize,
''',
    "artifact preview field",
)

old_headers = '''fn headers(profile: &ProviderProfile, credential: &str) -> AppResult<HeaderMap> {
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
'''
new_headers = '''fn headers(profile: &ProviderProfile, credential: &str) -> AppResult<HeaderMap> {
    let mut headers = request_headers(profile, credential)?;
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    Ok(headers)
}
'''
changed |= replace_once(MEDIA, old_headers, new_headers, "media headers")

old_request_body = '''fn request_body(profile: &ProviderProfile, input: &ImageGenerationInput) -> Value {
    let prompt = if let Some(negative) = input
        .negative_prompt
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        format!("{}\\n\\nAvoid: {}", input.prompt, negative)
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
'''
new_request_body = '''fn gemini_image_size(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let upper = value.to_ascii_uppercase();
    if matches!(upper.as_str(), "1K" | "2K" | "4K") {
        return Some(upper);
    }
    let (width, height) = upper.split_once('X')?;
    let width = width.parse::<u32>().ok()?;
    let height = height.parse::<u32>().ok()?;
    let largest = width.max(height);
    match largest {
        1..=1024 => Some("1K".into()),
        1025..=2048 => Some("2K".into()),
        2049..=4096 => Some("4K".into()),
        _ => None,
    }
}

fn request_body(profile: &ProviderProfile, input: &ImageGenerationInput) -> Value {
    let prompt = if let Some(negative) = input
        .negative_prompt
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        format!("{}\\n\\nAvoid: {}", input.prompt, negative)
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
        }),
        ProviderProtocol::GeminiNative => {
            let mut image_config = serde_json::Map::new();
            if let Some(aspect_ratio) = input
                .aspect_ratio
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                image_config.insert("aspectRatio".into(), Value::String(aspect_ratio.into()));
            }
            if let Some(image_size) = gemini_image_size(input.size.as_deref()) {
                image_config.insert("imageSize".into(), Value::String(image_size));
            }
            json!({
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {
                    "responseModalities": ["TEXT", "IMAGE"],
                    "candidateCount": input.count,
                    "imageConfig": Value::Object(image_config),
                }
            })
        }
        ProviderProtocol::AnthropicMessages => Value::Null,
    }
}
'''
changed |= replace_once(MEDIA, old_request_body, new_request_body, "media request body")

changed |= replace_once(
    MEDIA,
    '''fn collect_parts(value: &Value, output: &mut Vec<ProviderImage>, revised_prompt: Option<String>) {
''',
    '''fn collect_text_image(value: &str, output: &mut Vec<ProviderImage>) {
    if output.len() >= MAX_IMAGES as usize {
        return;
    }
    let value = value.trim();
    let candidate = if let Some((_, rest)) = value.split_once("](") {
        rest.strip_suffix(')').unwrap_or(rest).trim()
    } else {
        value
    };
    if let Some((media_type, data)) = data_url(candidate) {
        output.push(ProviderImage::Base64 {
            media_type: Some(media_type),
            data,
            revised_prompt: None,
        });
    } else if candidate.starts_with("https://") || candidate.starts_with("http://") {
        output.push(ProviderImage::Url {
            url: candidate.to_string(),
            revised_prompt: None,
        });
    }
}

fn collect_parts(value: &Value, output: &mut Vec<ProviderImage>, revised_prompt: Option<String>) {
''',
    "string image collector",
)

old_choices = '''    if let Some(choices) = value.get("choices").and_then(Value::as_array) {
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
'''
new_choices = '''    if let Some(choices) = value.get("choices").and_then(Value::as_array) {
        for choice in choices {
            if let Some(content) = choice
                .get("message")
                .and_then(|message| message.get("content"))
            {
                if let Some(parts) = content.as_array() {
                    for part in parts {
                        collect_parts(part, &mut output, None);
                    }
                } else if let Some(text) = content.as_str() {
                    collect_text_image(text, &mut output);
                }
            }
        }
    }
'''
changed |= replace_once(MEDIA, old_choices, new_choices, "string chat content")

changed |= replace_once(
    MEDIA,
    '''fn workspace_root(workspace_id: &str) -> AppResult<PathBuf> {
''',
    '''fn validate_image_dimensions(bytes: &[u8]) -> AppResult<()> {
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| fail("Provider output is not a supported image"))?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| fail("Could not read generated image dimensions"))?;
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || pixels > MAX_IMAGE_PIXELS
    {
        return Err(fail("Generated image dimensions exceed the allowed bounds"));
    }
    Ok(())
}

fn preview_data_url(bytes: &[u8], media_type: &str) -> Option<String> {
    (bytes.len() <= MAX_PREVIEW_BYTES)
        .then(|| format!("data:{media_type};base64,{}", STANDARD.encode(bytes)))
}

fn workspace_root(workspace_id: &str) -> AppResult<PathBuf> {
''',
    "dimension and preview helpers",
)

start = MEDIA.read_text(encoding="utf-8")
generate_start = start.index("pub async fn generate(input: ImageGenerationInput)")
tests_start = start.index("#[cfg(test)]", generate_start)
old_generate = start[generate_start:tests_start]
new_generate = '''pub async fn generate(input: ImageGenerationInput) -> AppResult<ImageGenerationResult> {
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

    let credential = if input.credential.is_empty() {
        connected_credential(&profile)?.unwrap_or_default()
    } else {
        input.credential.clone()
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| fail("Image provider client unavailable"))?;
    let response = client
        .post(endpoint(&profile, &input.model)?)
        .headers(headers(&profile, &credential)?)
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
        validate_image_dimensions(&bytes)?;
        let filename = format!("{:03}.{extension}", index + 1);
        let absolute_path = artifact_root.join(&filename);
        create_new(&absolute_path, &bytes)?;
        artifacts.push(ImageArtifact {
            id: format!("{}-{:03}", request_id, index + 1),
            absolute_path: absolute_path.to_string_lossy().into_owned(),
            relative_path: relative_root.join(&filename).to_string_lossy().into_owned(),
            preview_data_url: preview_data_url(&bytes, &media_type),
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
    let manifest_artifacts: Vec<_> = result
        .artifacts
        .iter()
        .map(|artifact| {
            json!({
                "id": artifact.id,
                "absolute_path": artifact.absolute_path,
                "relative_path": artifact.relative_path,
                "media_type": artifact.media_type,
                "byte_length": artifact.byte_length,
                "revised_prompt": artifact.revised_prompt,
            })
        })
        .collect();
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
        "artifacts": manifest_artifacts,
    }))
    .map_err(|_| fail("Could not serialize image manifest"))?;
    create_new(&manifest_path, &manifest)?;
    Ok(result)
}

'''
if old_generate == new_generate:
    pass
else:
    MEDIA.write_text(start[:generate_start] + new_generate + start[tests_start:], encoding="utf-8")
    changed = True

changed |= replace_once(
    PROVIDERS,
    '''fn request_headers(profile: &ProviderProfile, credential: &str) -> AppResult<HeaderMap> {
''',
    '''pub(crate) fn connected_credential(profile: &ProviderProfile) -> AppResult<Option<String>> {
    Ok(connection_vault()
        .lock()
        .map_err(|_| fail("Provider credential vault unavailable"))?
        .get(&profile.id)
        .filter(|connection| connection.generation == profile.generation)
        .map(|connection| connection.credential.as_str().to_string()))
}

pub(crate) fn request_headers(profile: &ProviderProfile, credential: &str) -> AppResult<HeaderMap> {
''',
    "provider credential helpers",
)
changed |= replace_once(
    PROVIDERS,
    '''    let credential = connection_vault()
        .lock()
        .map_err(|_| fail("Provider credential vault unavailable"))?
        .get(id)
        .filter(|connection| connection.generation == profile.generation)
        .map(|connection| connection.credential.as_str().to_string())
        .unwrap_or_default();
''',
    '''    let credential = connected_credential(&profile)?.unwrap_or_default();
''',
    "provider probe vault reuse",
)

changed |= replace_once(
    MEDIA_TYPES,
    '''  media_type:string;
  byte_length:number;
''',
    '''  media_type:string;
  preview_data_url:string|null;
  byte_length:number;
''',
    "typescript preview field",
)
changed |= replace_once(
    PAGE,
    ''' import { convertFileSrc } from '@tauri-apps/api/core';
''',
    '''''',
    "remove asset conversion import",
)
changed |= replace_once(
    PAGE,
    '''  profile.enabled&&profile.image_enabled&&profile.capabilities.includes('image_generation')&&allowedForTarget(profile,target)
''',
    '''  profile.enabled&&Boolean(profile.base_url)&&profile.image_enabled&&profile.capabilities.includes('image_generation')&&allowedForTarget(profile,target)
''',
    "filter routable image providers",
)
changed |= replace_once(
    PAGE,
    '''    <div class="gallery">{#each result.artifacts as artifact}<figure><img src={convertFileSrc(artifact.absolute_path)} alt={artifact.revised_prompt??prompt}/><figcaption><code>{artifact.relative_path}</code><span>{artifact.media_type} · {artifact.byte_length} bytes</span>{#if artifact.revised_prompt}<p>{artifact.revised_prompt}</p>{/if}</figcaption></figure>{/each}</div>
''',
    '''    <div class="gallery">{#each result.artifacts as artifact}<figure>{#if artifact.preview_data_url}<img src={artifact.preview_data_url} alt={artifact.revised_prompt??prompt}/>{:else}<div class="preview-unavailable"><Image size={32}/><span>{t($locale,'Preview unavailable for this large artifact.','呢個大型產物未提供預覽。')}</span></div>{/if}<figcaption><code>{artifact.relative_path}</code><span>{artifact.media_type} · {artifact.byte_length} bytes</span>{#if artifact.revised_prompt}<p>{artifact.revised_prompt}</p>{/if}</figcaption></figure>{/each}</div>
''',
    "safe image preview",
)
changed |= replace_once(
    PAGE,
    '''.gallery img{display:block;width:100%;height:auto;background:#111}.gallery figcaption''',
    '''.gallery img{display:block;width:100%;height:auto;background:#111}.preview-unavailable{min-height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.6rem;padding:1rem;text-align:center;color:var(--muted);background:#111}.gallery figcaption''',
    "preview fallback style",
)

for path in (MEDIA, PROVIDERS, MEDIA_TYPES, PAGE):
    if not path.read_text(encoding="utf-8").endswith("\n"):
        raise SystemExit(f"{path}: final newline missing")

print(f"IMAGE_REVIEW_FIXES_OK changed={str(changed).lower()}")
