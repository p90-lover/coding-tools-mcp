use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::SystemTime;

use regex::Regex;
use serde_json::{json, Value};
use walkdir::WalkDir;

use crate::tools::workspace::{tool_ok, Workspace, WorkspaceError};

/// Default per-file cap for `search_text`. Files are scanned line by line, so this only keeps
/// multi-GB assets out of a search; large logs and generated sources are searched.
const DEFAULT_SEARCH_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const BINARY_PEEK_BYTES: usize = 8192;
/// Largest `content` one read_file call returns. Tool results pass through the headless service,
/// which keeps at most 256 KiB of serialized result, so a page stays under that even after JSON
/// escaping. Larger files are read in pages with `next_offset`; there is no whole-file limit.
const MAX_READ_PAGE_BYTES: u64 = 192 * 1024;
const DEFAULT_READ_PAGE_BYTES: u64 = 128 * 1024;
/// UTF-16 text is decoded whole (Windows tools often write it), so it keeps a size limit.
const MAX_UTF16_READ_BYTES: u64 = 32 * 1024 * 1024;
/// Counting every line of a very large file on each page would make paging through it quadratic.
const MAX_LINE_COUNT_BYTES: u64 = 64 * 1024 * 1024;

fn read_error(_: std::io::Error) -> WorkspaceError {
    WorkspaceError::not_found("File could not be read")
}

/// One page of text taken from a reader positioned at the start of the content.
struct ReadWindow {
    content: Vec<u8>,
    first_line: usize,
    last_line: usize,
    begin: u64,
    end: u64,
    truncated: bool,
    cut_mid_line: bool,
    next_line: usize,
}

/// Reads at most `max_bytes` starting either at byte `offset` or at line `start_line`, stopping
/// after `end_line`. Memory stays bounded by `max_bytes` even for a single multi-gigabyte line.
fn read_window<R: BufRead>(
    mut reader: R,
    skip: u64,
    offset: Option<u64>,
    start_line: usize,
    end_line: Option<usize>,
    max_bytes: usize,
) -> std::io::Result<ReadWindow> {
    let mut pos = 0u64;
    let mut scratch = Vec::new();
    // Skip a byte-order mark; it is not part of the text.
    pos += std::io::copy(&mut (&mut reader).take(skip), &mut std::io::sink())?;
    let first_line = if let Some(offset) = offset {
        let mut newlines = 0usize;
        let mut remaining = offset.saturating_sub(pos);
        while remaining > 0 {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                break;
            }
            let take = available.len().min(remaining as usize);
            newlines += available[..take]
                .iter()
                .filter(|byte| **byte == b'\n')
                .count();
            reader.consume(take);
            pos += take as u64;
            remaining -= take as u64;
        }
        // An offset inside a multi-byte character moves forward to the next character.
        while reader
            .fill_buf()?
            .first()
            .is_some_and(|byte| byte & 0b1100_0000 == 0b1000_0000)
        {
            reader.consume(1);
            pos += 1;
        }
        newlines + 1
    } else {
        let mut line = 1;
        while line < start_line {
            scratch.clear();
            // Bounded per chunk, so a huge skipped line never has to fit in memory.
            let read = (&mut reader)
                .take(64 * 1024)
                .read_until(b'\n', &mut scratch)?;
            if read == 0 {
                break;
            }
            pos += read as u64;
            if scratch.last() == Some(&b'\n') {
                line += 1;
            }
        }
        line
    };
    let begin = pos;
    let mut content = Vec::new();
    let mut line_no = first_line;
    let mut last_line = first_line.saturating_sub(1);
    let mut truncated = false;
    let mut cut_mid_line = false;
    loop {
        if end_line.is_some_and(|end| line_no > end) {
            break;
        }
        let room = max_bytes - content.len();
        scratch.clear();
        let read = (&mut reader)
            .take(room as u64 + 1)
            .read_until(b'\n', &mut scratch)?;
        if read == 0 {
            break;
        }
        if scratch.len() > room {
            // Stop on a character boundary; at least one whole character is always returned.
            let mut cut = room;
            while cut > 0 && scratch[cut] & 0b1100_0000 == 0b1000_0000 {
                cut -= 1;
            }
            if cut == 0 && content.is_empty() {
                cut = 1;
                while cut < scratch.len() && scratch[cut] & 0b1100_0000 == 0b1000_0000 {
                    cut += 1;
                }
            }
            content.extend_from_slice(&scratch[..cut]);
            pos += cut as u64;
            truncated = true;
            if cut > 0 {
                last_line = line_no;
                cut_mid_line = scratch[cut - 1] != b'\n';
                if !cut_mid_line {
                    line_no += 1;
                }
            }
            break;
        }
        content.extend_from_slice(&scratch);
        pos += read as u64;
        last_line = line_no;
        if scratch.last() == Some(&b'\n') {
            line_no += 1;
        }
    }
    Ok(ReadWindow {
        content,
        first_line,
        last_line,
        begin,
        end: pos,
        truncated,
        cut_mid_line,
        next_line: line_no,
    })
}

/// Lines in the same sense as `str::split_inclusive('\n')`: a final unterminated line counts.
fn count_lines<R: Read>(mut reader: R) -> std::io::Result<usize> {
    let mut buffer = vec![0u8; 256 * 1024];
    let (mut lines, mut last) = (0usize, b'\n');
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        lines += buffer[..read].iter().filter(|byte| **byte == b'\n').count();
        last = buffer[read - 1];
    }
    Ok(lines + usize::from(last != b'\n'))
}

pub fn read_file(ws: &Workspace, args: &Value) -> Result<Value, WorkspaceError> {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| WorkspaceError::invalid_argument("path is required"))?;
    let resolved = ws.resolve_read_path(path)?;
    if resolved.path.is_dir() {
        return Err(WorkspaceError::Tool {
            code: "IS_DIRECTORY",
            message: "Path is a directory.".into(),
            category: "validation",
            retryable: false,
        });
    }
    let mut input =
        File::open(&resolved.path).map_err(|_| WorkspaceError::not_found("File not found"))?;
    let file_bytes = input
        .metadata()
        .map_err(|_| WorkspaceError::not_found("File not found"))?
        .len();
    let requested_max = args.get("max_bytes").and_then(Value::as_u64);
    // At least 4 bytes, so one character always fits.
    let max_bytes = requested_max
        .unwrap_or(DEFAULT_READ_PAGE_BYTES)
        .clamp(4, MAX_READ_PAGE_BYTES) as usize;
    let start_line = args
        .get("start_line")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
    let end_line = args
        .get("end_line")
        .and_then(Value::as_u64)
        .map(|v| v as usize);
    let offset = args.get("offset").and_then(Value::as_u64);

    let mut head = [0u8; BINARY_PEEK_BYTES];
    let mut head_len = 0;
    while head_len < head.len() {
        let read = input.read(&mut head[head_len..]).map_err(read_error)?;
        if read == 0 {
            break;
        }
        head_len += read;
    }
    let head = &head[..head_len];
    input.seek(SeekFrom::Start(0)).map_err(read_error)?;
    let utf16 = match head {
        [0xFF, 0xFE, ..] => Some(true),
        [0xFE, 0xFF, ..] => Some(false),
        _ => None,
    };
    if utf16.is_none() && head.contains(&0) {
        return Err(WorkspaceError::Tool {
            code: "BINARY_FILE",
            message:
                "Binary file read blocked for text tool (UTF-16 text needs a byte-order mark)."
                    .into(),
            category: "validation",
            retryable: false,
        });
    }
    let mut warnings = Vec::new();
    let (window, encoding, total_bytes, total_lines) = if let Some(little_endian) = utf16 {
        if file_bytes > MAX_UTF16_READ_BYTES {
            return Err(WorkspaceError::Tool {
                code: "FILE_TOO_LARGE",
                message: format!(
                    "UTF-16 file is {file_bytes} bytes; read_file decodes UTF-16 up to {MAX_UTF16_READ_BYTES} bytes. Convert it to UTF-8 first."
                ),
                category: "validation",
                retryable: false,
            });
        }
        let mut raw = Vec::new();
        input
            .take(MAX_UTF16_READ_BYTES)
            .read_to_end(&mut raw)
            .map_err(read_error)?;
        let units: Vec<u16> = raw
            .get(2..)
            .unwrap_or_default()
            .chunks_exact(2)
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        let text = String::from_utf16_lossy(&units).into_bytes();
        warnings.push("decoded from UTF-16; offsets count bytes of the UTF-8 text".to_string());
        let total_lines = count_lines(text.as_slice()).map_err(read_error)?;
        let total = text.len() as u64;
        let window = read_window(
            std::io::Cursor::new(text),
            0,
            offset,
            start_line,
            end_line,
            max_bytes,
        )
        .map_err(read_error)?;
        let encoding = if little_endian {
            "utf-16le"
        } else {
            "utf-16be"
        };
        (window, encoding, total, Some(total_lines))
    } else {
        let bom = if head.starts_with(&[0xEF, 0xBB, 0xBF]) {
            3
        } else {
            0
        };
        let total_lines = if file_bytes <= MAX_LINE_COUNT_BYTES {
            let lines = count_lines(BufReader::new(&mut input)).map_err(read_error)?;
            input.seek(SeekFrom::Start(0)).map_err(read_error)?;
            Some(lines)
        } else {
            warnings.push(format!(
                "total_lines is not counted for files over {MAX_LINE_COUNT_BYTES} bytes"
            ));
            None
        };
        let window = read_window(
            BufReader::new(input),
            bom,
            offset,
            start_line,
            end_line,
            max_bytes,
        )
        .map_err(read_error)?;
        (window, "utf-8", file_bytes, total_lines)
    };
    let content = match String::from_utf8(window.content) {
        Ok(text) => text,
        Err(error) => {
            warnings.push("invalid UTF-8 bytes were replaced with U+FFFD".to_string());
            String::from_utf8_lossy(error.as_bytes()).into_owned()
        }
    };
    if requested_max.is_some_and(|requested| requested > MAX_READ_PAGE_BYTES) {
        warnings.push(format!(
            "max_bytes is capped at {MAX_READ_PAGE_BYTES} per call"
        ));
    }
    let more = window.end < total_bytes;
    if window.truncated {
        warnings.push("content truncated; continue with next_offset".to_string());
    }
    let mut result = json!({
        "path": resolved.display,
        "content": content,
        "encoding": encoding,
        "start_line": window.first_line,
        "end_line": window.last_line,
        "total_bytes": total_bytes,
        "bytes_read": window.end - window.begin,
        "offset": window.begin,
        "truncated": window.truncated,
        "truncated_by": window.truncated.then_some("bytes"),
        "cut_mid_line": window.cut_mid_line,
        "next_offset": more.then_some(window.end),
        "next_start_line": (more && !window.cut_mid_line).then_some(window.next_line),
        "warnings": warnings
    });
    if let Some(lines) = total_lines {
        result["total_lines"] = json!(lines);
    }
    Ok(tool_ok(result))
}

pub fn list_dir(ws: &Workspace, args: &Value) -> Result<Value, WorkspaceError> {
    let path = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let resolved = ws.resolve_read_path(path)?;
    if !resolved.path.is_dir() {
        return Err(WorkspaceError::not_a_directory("Path is not a directory"));
    }
    let recursive = args
        .get("recursive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let max_depth = args
        .get("max_depth")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
    let max_entries = args
        .get("max_entries")
        .and_then(Value::as_u64)
        .unwrap_or(1000) as usize;
    let include_hidden = args
        .get("include_hidden")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let include_ignored = args
        .get("include_ignored")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut entries = Vec::new();
    let mut truncated = false;
    collect_dir_entries(
        ws,
        &resolved.path,
        &resolved.display,
        1,
        max_depth,
        recursive,
        include_hidden,
        include_ignored,
        max_entries,
        &mut entries,
        &mut truncated,
    );
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(tool_ok(json!({
        "path": resolved.display,
        "entries": entries,
        "truncated": truncated,
        "warnings": if truncated { vec!["entry limit reached"] } else { vec![] }
    })))
}

pub fn list_files(ws: &Workspace, args: &Value) -> Result<Value, WorkspaceError> {
    let path = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let resolved = ws.resolve_read_path(path)?;
    if !resolved.path.is_dir() {
        return Err(WorkspaceError::not_a_directory("Path is not a directory"));
    }
    let patterns = list_files_patterns(args);
    let exclude_patterns = string_list_arg(args, "exclude_patterns");
    let max_results = args
        .get("max_results")
        .and_then(Value::as_u64)
        .unwrap_or(5000) as usize;
    let include_hidden = args
        .get("include_hidden")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let include_ignored = args
        .get("include_ignored")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut files = Vec::new();
    let mut truncated = false;
    // Skip ignored directories (node_modules, target, ...) whole instead of visiting every file.
    for entry in WalkDir::new(&resolved.path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.path() == resolved.path
                || !entry.file_type().is_dir()
                || !ws.is_ignored_path(entry.path(), include_hidden, include_ignored)
        })
        .filter_map(Result::ok)
    {
        let p = entry.path();
        if p == resolved.path {
            continue;
        }
        if !ws.is_safe_read_path(p) {
            continue;
        }
        if ws.is_ignored_path(p, include_hidden, include_ignored) {
            if entry.file_type().is_dir() {
                continue;
            }
            continue;
        }
        if !entry.file_type().is_file() && !entry.file_type().is_symlink() {
            continue;
        }
        let rel = ws.display_path(p);
        if !patterns.iter().any(|pat| glob_match(pat, &rel)) {
            continue;
        }
        if exclude_patterns.iter().any(|pat| glob_match(pat, &rel)) {
            continue;
        }
        let meta = p.symlink_metadata().ok();
        files.push(json!({
            "path": rel,
            "type": if entry.file_type().is_symlink() { "symlink" } else { "file" },
            "size_bytes": meta.as_ref().map(|m| m.len()).unwrap_or(0),
            "modified": meta.and_then(|m| format_mtime(m.modified().ok()))
        }));
        if files.len() >= max_results {
            truncated = true;
            break;
        }
    }
    files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(tool_ok(json!({
        "path": resolved.display,
        "files": files,
        "truncated": truncated,
        "warnings": if truncated { vec!["result limit reached"] } else { vec![] }
    })))
}

pub fn search_text(ws: &Workspace, args: &Value) -> Result<Value, WorkspaceError> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| WorkspaceError::invalid_argument("query is required"))?;
    let path = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let resolved = ws.resolve_read_path(path)?;
    let use_regex = args.get("regex").and_then(Value::as_bool).unwrap_or(false);
    let case_sensitive = args
        .get("case_sensitive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let max_results = args
        .get("max_results")
        .and_then(Value::as_u64)
        .unwrap_or(1000) as usize;
    let max_preview = args
        .get("max_preview_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(512) as usize;
    let max_file_bytes = args
        .get("max_file_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_SEARCH_MAX_FILE_BYTES)
        .max(1);

    let (include_globs, exclude_globs) = search_globs(args);
    let context_lines = args
        .get("context_lines")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let matcher = build_matcher(query, use_regex, case_sensitive)?;

    let mut matches = Vec::new();
    let mut warnings = Vec::new();
    let mut skipped_large = 0usize;
    let mut skipped_binary = 0usize;
    let mut truncated = false;

    let mut consider_file = |p: &Path| {
        if matches.len() >= max_results {
            truncated = true;
            return false;
        }
        if !ws.is_safe_read_path(p) {
            return true;
        }
        if ws.is_ignored_path(p, false, false) {
            return true;
        }
        let rel = ws.display_path(p);
        if !passes_glob_filters(&rel, &include_globs, &exclude_globs) {
            return true;
        }
        let meta = match p.metadata() {
            Ok(m) if m.is_file() => m,
            _ => return true,
        };
        if meta.len() > max_file_bytes {
            skipped_large += 1;
            return true;
        }
        match file_text_eligibility(p) {
            FileEligibility::Binary => {
                skipped_binary += 1;
                return true;
            }
            FileEligibility::Unreadable => return true,
            FileEligibility::Text => {}
        }
        let stop = search_file_streaming(
            p,
            &rel,
            &matcher,
            context_lines,
            max_preview,
            max_results,
            &mut matches,
        );
        if stop {
            truncated = true;
            return false;
        }
        true
    };

    if resolved.path.is_file() {
        let _ = consider_file(&resolved.path);
    } else {
        // Ignored and hidden directories are pruned whole, matching the per-file rule below.
        for entry in WalkDir::new(&resolved.path)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.path() == resolved.path
                    || !entry.file_type().is_dir()
                    || !ws.is_ignored_path(entry.path(), false, false)
            })
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            if !consider_file(entry.path()) {
                break;
            }
        }
    }

    if truncated {
        warnings.push("result limit reached; scan stopped early".to_string());
    }
    if skipped_large > 0 {
        warnings.push(format!(
            "skipped {skipped_large} file(s) larger than max_file_bytes ({max_file_bytes})"
        ));
    }
    if skipped_binary > 0 {
        warnings.push(format!(
            "skipped {skipped_binary} binary or non-utf8 file(s)"
        ));
    }

    Ok(tool_ok(json!({
        "query": query,
        "matches": matches,
        "total_matches": matches.len(),
        "truncated": truncated,
        "max_file_bytes": max_file_bytes,
        "skipped_large_files": skipped_large,
        "skipped_binary_files": skipped_binary,
        "warnings": warnings
    })))
}

enum FileEligibility {
    Text,
    Binary,
    Unreadable,
}

fn file_text_eligibility(path: &Path) -> FileEligibility {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return FileEligibility::Unreadable,
    };
    let mut buf = [0u8; BINARY_PEEK_BYTES];
    let n = match file.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return FileEligibility::Unreadable,
    };
    if buf[..n].contains(&0) {
        return FileEligibility::Binary;
    }
    FileEligibility::Text
}

/// Stream a file line-by-line. Returns true when `max_results` is reached.
fn search_file_streaming(
    path: &Path,
    rel: &str,
    matcher: &Matcher,
    context_lines: usize,
    max_preview: usize,
    max_results: usize,
    matches: &mut Vec<Value>,
) -> bool {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut reader = BufReader::new(file);
    let mut recent: VecDeque<String> = VecDeque::with_capacity(context_lines.max(1));
    let mut pending: Vec<PendingMatch> = Vec::new();
    let mut line_no = 0usize;
    let mut raw = Vec::new();

    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => {
                flush_pending(&mut pending, matches, max_results);
                return matches.len() >= max_results;
            }
        }
        // Invalid UTF-8 no longer ends the file: such lines are searched with U+FFFD in place.
        let trimmed = raw.strip_suffix(b"\n").unwrap_or(&raw);
        let trimmed = trimmed.strip_suffix(b"\r").unwrap_or(trimmed);
        let line = String::from_utf8_lossy(trimmed).into_owned();
        line_no += 1;

        // Feed "after" context for earlier hits.
        if context_lines > 0 {
            for pend in &mut pending {
                if pend.after.len() < context_lines {
                    pend.after.push(line.clone());
                }
            }
            while pending
                .first()
                .is_some_and(|front| front.after.len() >= context_lines)
            {
                let done = pending.remove(0);
                matches.push(done.into_value());
                if matches.len() >= max_results {
                    return true;
                }
            }
        }

        if matcher.is_match(&line) {
            let preview = preview_line(&line, max_preview);
            if context_lines == 0 {
                matches.push(json!({
                    "path": rel,
                    "line": line_no,
                    "column": 1,
                    "preview": preview
                }));
                if matches.len() >= max_results {
                    return true;
                }
            } else {
                pending.push(PendingMatch {
                    path: rel.to_string(),
                    line: line_no,
                    preview,
                    before: recent.iter().cloned().collect(),
                    after: Vec::new(),
                });
            }
        }

        if context_lines > 0 {
            recent.push_back(line);
            while recent.len() > context_lines {
                recent.pop_front();
            }
        }
    }

    // EOF: emit remaining pending with partial after context.
    for pend in pending {
        matches.push(pend.into_value());
        if matches.len() >= max_results {
            return true;
        }
    }
    false
}

struct PendingMatch {
    path: String,
    line: usize,
    preview: String,
    before: Vec<String>,
    after: Vec<String>,
}

impl PendingMatch {
    fn into_value(self) -> Value {
        json!({
            "path": self.path,
            "line": self.line,
            "column": 1,
            "preview": self.preview,
            "before": self.before,
            "after": self.after
        })
    }
}

fn preview_line(line: &str, max_preview: usize) -> String {
    if line.len() <= max_preview {
        return line.to_string();
    }
    let mut end = max_preview;
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &line[..end])
}

fn flush_pending(pending: &mut Vec<PendingMatch>, matches: &mut Vec<Value>, max_results: usize) {
    for pend in pending.drain(..) {
        if matches.len() >= max_results {
            break;
        }
        matches.push(pend.into_value());
    }
}

fn build_matcher(
    query: &str,
    use_regex: bool,
    case_sensitive: bool,
) -> Result<Matcher, WorkspaceError> {
    if use_regex {
        let pattern = if case_sensitive {
            Regex::new(query)
        } else {
            Regex::new(&format!("(?i:{query})"))
        }
        .map_err(|e| WorkspaceError::invalid_argument(format!("Invalid regex: {e}")))?;
        Ok(Matcher::Regex(pattern))
    } else if case_sensitive {
        Ok(Matcher::Exact(query.to_string()))
    } else {
        Ok(Matcher::AnyCase(query.to_lowercase()))
    }
}

enum Matcher {
    Regex(Regex),
    /// `case_sensitive: true` matches exactly, even for an all-lowercase query.
    Exact(String),
    AnyCase(String),
}

impl Matcher {
    fn is_match(&self, line: &str) -> bool {
        match self {
            Matcher::Regex(re) => re.is_match(line),
            Matcher::Exact(literal) => line.contains(literal.as_str()),
            Matcher::AnyCase(lowered) => line.to_lowercase().contains(lowered.as_str()),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_dir_entries(
    ws: &Workspace,
    dir: &Path,
    display: &str,
    depth: usize,
    max_depth: usize,
    recursive: bool,
    include_hidden: bool,
    include_ignored: bool,
    max_entries: usize,
    entries: &mut Vec<Value>,
    truncated: &mut bool,
) {
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for item in read_dir.flatten() {
        if *truncated {
            return;
        }
        let p = item.path();
        if ws.is_ignored_path(&p, include_hidden, include_ignored) {
            continue;
        }
        let name = item.file_name().to_string_lossy().into_owned();
        let rel = if display == "." {
            name.clone()
        } else {
            format!("{display}/{name}")
        };
        let ft = item.file_type().ok();
        let entry_type = if ft.as_ref().map(|t| t.is_symlink()).unwrap_or(false) {
            "symlink"
        } else if ft.as_ref().map(|t| t.is_dir()).unwrap_or(false) {
            "directory"
        } else if ft.as_ref().map(|t| t.is_file()).unwrap_or(false) {
            "file"
        } else {
            "other"
        };
        let meta = item.metadata().ok();
        entries.push(json!({
            "name": name,
            "path": rel.replace('\\', "/"),
            "type": entry_type,
            "size_bytes": meta.as_ref().map(|m| m.len()).unwrap_or(0),
            "modified": meta.and_then(|m| format_mtime(m.modified().ok())),
            "is_hidden": name.starts_with('.'),
            "is_ignored": false
        }));
        if entries.len() >= max_entries {
            *truncated = true;
            return;
        }
        if recursive && depth < max_depth && entry_type == "directory" && !p.is_symlink() {
            collect_dir_entries(
                ws,
                &p,
                &rel.replace('\\', "/"),
                depth + 1,
                max_depth,
                recursive,
                include_hidden,
                include_ignored,
                max_entries,
                entries,
                truncated,
            );
        }
    }
}

fn string_list_arg(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn list_files_patterns(args: &Value) -> Vec<String> {
    let patterns = string_list_arg(args, "patterns");
    if !patterns.is_empty() {
        return patterns;
    }
    if let Some(glob) = args.get("glob").and_then(Value::as_str) {
        if !glob.is_empty() {
            return vec![glob.to_string()];
        }
    }
    vec!["**/*".to_string()]
}

fn search_globs(args: &Value) -> (Vec<String>, Vec<String>) {
    let mut include = string_list_arg(args, "include_globs");
    if let Some(glob) = args.get("glob").and_then(Value::as_str) {
        if !glob.is_empty() {
            include.push(glob.to_string());
        }
    }
    (include, string_list_arg(args, "exclude_globs"))
}

fn passes_glob_filters(rel: &str, include: &[String], exclude: &[String]) -> bool {
    if !include.is_empty() && !include.iter().any(|pat| glob_match(pat, rel)) {
        return false;
    }
    !exclude.iter().any(|pat| glob_match(pat, rel))
}

fn glob_match(pattern: &str, path: &str) -> bool {
    let pat = pattern.replace('\\', "/");
    let p = path.replace('\\', "/");
    if pat == "**/*" || pat == "*" {
        return true;
    }
    if let Some(suffix) = pat.strip_prefix("**/") {
        return simple_glob(suffix, &p) || p.split('/').any(|part| simple_glob(suffix, part));
    }
    simple_glob(&pat, &p)
}

fn simple_glob(pattern: &str, text: &str) -> bool {
    glob::Pattern::new(pattern)
        .map(|p| p.matches(text))
        .unwrap_or(false)
}

fn format_mtime(st: Option<SystemTime>) -> Option<String> {
    st.map(|t| {
        let d = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        format!("{}.{:03}Z", d.as_secs(), d.subsec_millis())
    })
}
