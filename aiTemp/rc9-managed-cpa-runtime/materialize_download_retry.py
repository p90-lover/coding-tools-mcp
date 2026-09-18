from __future__ import annotations

from pathlib import Path

TARGET = Path("desktop-electron/electron/managed-components.cjs")
text = TARGET.read_text(encoding="utf-8")

old_constants = '''const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60_000;'''
new_constants = '''const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_DOWNLOAD_ATTEMPTS = 4;
const DEFAULT_DOWNLOAD_RETRY_BASE_MS = 250;
const MAX_DOWNLOAD_RETRY_DELAY_MS = 5_000;
const RETRYABLE_DOWNLOAD_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60_000;'''

old_downloader = '''  async function downloadAsset(url, destination) {
    const response = await fetchImpl(url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    const length = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) throw new Error("Managed component download exceeds the size limit");
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const file = fs.createWriteStream(destination, { flags: "wx", mode: 0o700 });
    await pipeline(Readable.fromWeb(response.body), file);
    if (fs.statSync(destination).size > MAX_DOWNLOAD_BYTES) throw new Error("Managed component download exceeds the size limit");
  }

  async function prepareReleaseBinary(manifest, stagingHome) {
    const asset = selectedReleaseAsset(manifest);
    const artifact = path.join(stagingHome, assertSafeRelativePath(asset.fileName, `${manifest.id} filename`));
    setOperation(manifest.id, { state: "installing", step: "download-release", error: null });
    await downloadAsset(asset.url, artifact);
    setOperation(manifest.id, { state: "installing", step: "verify-sha256", error: null });
    verifySha256(artifact, asset.sha256);
    if (platform !== "win32") fs.chmodSync(artifact, 0o700);
    return { artifact };
  }'''

new_downloader = '''  function retryableDownloadStatus(status) {
    return status === 408
      || status === 425
      || status === 429
      || (status >= 500 && status <= 599);
  }

  function retryableDownloadError(error) {
    if (error?.retryable === true) return true;
    const code = String(error?.cause?.code || error?.code || "").toUpperCase();
    return RETRYABLE_DOWNLOAD_CODES.has(code)
      || (error instanceof TypeError && !String(error.message || "").includes("Invalid URL"));
  }

  function retryAfterMilliseconds(response, attempt) {
    const value = String(response?.headers?.get?.("retry-after") || "").trim();
    if (value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(MAX_DOWNLOAD_RETRY_DELAY_MS, Math.round(seconds * 1_000));
      }
      const date = Date.parse(value);
      if (Number.isFinite(date)) {
        return Math.min(MAX_DOWNLOAD_RETRY_DELAY_MS, Math.max(0, date - Date.now()));
      }
    }
    return Math.min(
      MAX_DOWNLOAD_RETRY_DELAY_MS,
      DEFAULT_DOWNLOAD_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)),
    );
  }

  function retainFailedDownload(partialPath, manifest, reason) {
    if (!partialPath || !fs.existsSync(partialPath)) return null;
    assertWithin(aiTempRoot, partialPath, "Managed component partial download");
    const destination = path.join(
      trashRoot,
      manifest.id,
      `${timestampSegment(now())}-${safeSegment(reason)}-${crypto.randomUUID()}`,
    );
    assertWithin(trashRoot, destination, "Managed component download Trash destination");
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    const retainedPath = path.join(destination, path.basename(partialPath));
    fs.renameSync(partialPath, retainedPath);
    writeJson(path.join(destination, "CODING_TOOLS_TRASH_RECORD.json"), {
      schemaVersion: 1,
      id: manifest.id,
      version: manifest.version,
      commit: manifest.commit || null,
      reason,
      movedAt: now(),
      retainedFile: path.basename(retainedPath),
    });
    return retainedPath;
  }

  async function downloadAsset(url, destination, manifest) {
    let lastError = null;
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });

    for (let attempt = 1; attempt <= DEFAULT_DOWNLOAD_ATTEMPTS; attempt += 1) {
      const partialPath = `${destination}.attempt-${attempt}-${crypto.randomUUID()}.partial`;
      let response = null;
      try {
        response = await fetchImpl(url, { redirect: "follow" });
        if (!response.ok || !response.body) {
          const error = new Error(`Download failed: HTTP ${response.status}`);
          error.status = response.status;
          error.retryable = retryableDownloadStatus(response.status);
          try { await response.body?.cancel?.(); } catch {}
          throw error;
        }

        const length = Number(response.headers?.get?.("content-length") || 0);
        if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
          try { await response.body.cancel(); } catch {}
          throw new Error("Managed component download exceeds the size limit");
        }

        const file = fs.createWriteStream(partialPath, { flags: "wx", mode: 0o700 });
        await pipeline(Readable.fromWeb(response.body), file);
        if (fs.statSync(partialPath).size > MAX_DOWNLOAD_BYTES) {
          throw new Error("Managed component download exceeds the size limit");
        }
        fs.renameSync(partialPath, destination);
        return;
      } catch (error) {
        lastError = error;
        try {
          retainFailedDownload(partialPath, manifest, `download-attempt-${attempt}-failed`);
        } catch (retentionError) {
          logger?.error?.("managed-component.download_retention_failed", {
            componentId: manifest.id,
            attempt,
            error: retentionError instanceof Error ? retentionError.message : String(retentionError),
          });
        }

        const retryable = retryableDownloadError(error);
        if (!retryable || attempt >= DEFAULT_DOWNLOAD_ATTEMPTS) throw error;
        const delayMs = retryAfterMilliseconds(response, attempt);
        logger?.warn?.("managed-component.download_retry", {
          componentId: manifest.id,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: DEFAULT_DOWNLOAD_ATTEMPTS,
          status: Number.isInteger(error?.status) ? error.status : null,
          code: String(error?.cause?.code || error?.code || "") || null,
          delayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError || new Error("Managed component download failed");
  }

  async function prepareReleaseBinary(manifest, stagingHome) {
    const asset = selectedReleaseAsset(manifest);
    const artifact = path.join(stagingHome, assertSafeRelativePath(asset.fileName, `${manifest.id} filename`));
    setOperation(manifest.id, { state: "installing", step: "download-release", error: null });
    await downloadAsset(asset.url, artifact, manifest);
    setOperation(manifest.id, { state: "installing", step: "verify-sha256", error: null });
    verifySha256(artifact, asset.sha256);
    if (platform !== "win32") fs.chmodSync(artifact, 0o700);
    return { artifact };
  }'''

if new_constants not in text:
    count = text.count(old_constants)
    if count != 1:
        raise SystemExit(f"expected one constants anchor, found {count}")
    text = text.replace(old_constants, new_constants, 1)

if new_downloader not in text:
    count = text.count(old_downloader)
    if count != 1:
        raise SystemExit(f"expected one downloader anchor, found {count}")
    text = text.replace(old_downloader, new_downloader, 1)

TARGET.write_text(text, encoding="utf-8")
print("RC9_CPA_DOWNLOAD_RETRY_MATERIALIZED")
