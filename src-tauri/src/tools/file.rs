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
/// Cooperative scan budget: walking and bounded reads return partial results on expiry
/// (`timed_out: true`). A blocked filesystem operation or one regex evaluation cannot be preempted.
const DEFAULT_SEARCH_TIME_BUDGET_MS: u64 = 15_000;
const MAX_SEARCH_TIME_BUDGET_MS: u64 = 60_000;
const SEARCH_READ_CHUNK_BYTES: u64 = 64 * 1024;
const BINARY_PEEK_BYTES: usize = 8192;
/// Raw-byte upper bound for one read_file page. Shared dispatch can return a smaller page so the
/// complete decorated result fits its serialized budget. Larger files use `next_offset`.
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

pub(super) struct ReadFilePage {
    window: ReadWindow,
    path: String,
    encoding: &'static str,
    total_bytes: u64,
    total_lines: Option<usize>,
    warnings: Vec<String>,
    requested_max: Option<u64>,
}

impl ReadFilePage {
    pub(super) fn value(&self) -> Value {
        self.value_for(&self.window)
    }

    fn value_for(&self, window: &ReadWindow) -> Value {
        let mut warnings = self.warnings.clone();
        let content = match String::from_utf8(window.content.clone()) {
            Ok(text) => text,
            Err(error) => {
                warnings.push("invalid UTF-8 bytes were replaced with U+FFFD".to_string());
                String::from_utf8_lossy(error.as_bytes()).into_owned()
            }
        };
        if self
            .requested_max
            .is_some_and(|requested| requested > MAX_READ_PAGE_BYTES)
        {
            warnings.push(format!(
                "max_bytes is capped at {MAX_READ_PAGE_BYTES} per call"
            ));
        }
        if window.truncated {
            warnings.push("content truncated; continue with next_offset".to_string());
        }
        let more = window.end < self.total_bytes;
        let mut result = json!({
            "path": self.path,
            "content": content,
            "encoding": self.encoding,
            "start_line": window.first_line,
            "end_line": window.last_line,
            "total_bytes": self.total_bytes,
            "bytes_read": window.end - window.begin,
            "offset": window.begin,
            "truncated": window.truncated,
            "truncated_by": window.truncated.then_some("bytes"),
            "cut_mid_line": window.cut_mid_line,
            "next_offset": more.then_some(window.end),
            "next_start_line": (more && !window.cut_mid_line).then_some(window.next_line),
            "warnings": warnings
        });
        if let Some(lines) = self.total_lines {
            result["total_lines"] = json!(lines);
        }
        tool_ok(result)
    }

    pub(super) fn fit_result(self, mut output: Value, limit: usize) -> Value {
        let mut buffer = vec![0; limit];
        let mut fits = |value: &Value| {
            let mut writer = std::io::Cursor::new(buffer.as_mut_slice());
            serde_json::to_writer(&mut writer, value).is_ok()
        };
        if fits(&output) {
            return output;
        }

        let mut candidate = output.clone();
        let mut raw_cap = self.window.content.len();
        while raw_cap > 4 {
            raw_cap = (raw_cap / 2).max(4);
            // This is an already-owned window: offset=Some(0) would skip leading invalid
            // continuation bytes. Only the original file read performs offset alignment.
            let mut window = read_window(
                std::io::Cursor::new(self.window.content.as_slice()),
                0,
                None,
                1,
                None,
                raw_cap,
            )
            .expect("reading an in-memory file page");
            if window.content.is_empty() || window.content.len() >= self.window.content.len() {
                break;
            }
            window.begin += self.window.begin;
            window.end += self.window.begin;
            let line_shift = self.window.first_line - 1;
            window.first_line += line_shift;
            window.last_line += line_shift;
            window.next_line += line_shift;
            window.truncated |= self.window.truncated;
            let Value::Object(fields) = self.value_for(&window) else {
                unreachable!("file result is an object")
            };
            candidate
                .as_object_mut()
                .expect("decorated file result is an object")
                .extend(fields);
            if fits(&candidate) {
                return candidate;
            }
        }

        let mut error = crate::tools::workspace::tool_err(WorkspaceError::Tool {
            code: "RESULT_TOO_LARGE",
            message: "Required response metadata and the minimum file page exceed the tool-result byte budget; no file page or continuation cursor was returned.".into(),
            category: "validation",
            retryable: false,
        });
        // Required metadata is never trimmed or loaded again. If it alone exceeds the limit,
        // the transport's existing whole-value guard still reports the explicit failure.
        for key in [
            "project_instructions",
            "project_scope",
            "server_dispatch_ms",
        ] {
            if let Some(value) = output.as_object_mut().and_then(|object| object.remove(key)) {
                error[key] = value;
            }
        }
        error
    }
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
    read_file_page(ws, args).map(|page| page.value())
}

pub(super) fn read_file_page(ws: &Workspace, args: &Value) -> Result<ReadFilePage, WorkspaceError> {
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
    ws.verify_opened(&input, &resolved.path)?;
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
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes(*pair)
                } else {
                    u16::from_be_bytes(*pair)
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
    Ok(ReadFilePage {
        window,
        path: resolved.display,
        encoding,
        total_bytes,
        total_lines,
        warnings,
        requested_max,
    })
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SearchStop {
    Complete,
    ResultLimit,
    Deadline,
}

fn walk_search_files(
    root: &Path,
    skip_entry: impl Fn(&walkdir::DirEntry) -> bool,
    mut consider_file: impl FnMut(&Path) -> SearchStop,
    expired: &dyn Fn() -> bool,
) -> SearchStop {
    let mut entries = WalkDir::new(root).follow_links(false).into_iter();
    loop {
        if expired() {
            return SearchStop::Deadline;
        }
        let next = entries.next();
        if expired() {
            return SearchStop::Deadline;
        }
        let entry = match next {
            Some(Ok(entry)) => entry,
            Some(Err(_)) => continue,
            None => return SearchStop::Complete,
        };
        if skip_entry(&entry) {
            if entry.file_type().is_dir() {
                entries.skip_current_dir();
            }
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let stop = consider_file(entry.path());
        if stop != SearchStop::Complete {
            return stop;
        }
    }
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
    let include_ignored = args
        .get("include_ignored")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let budget = std::time::Duration::from_millis(
        args.get("time_budget_ms")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_SEARCH_TIME_BUDGET_MS)
            .clamp(1, MAX_SEARCH_TIME_BUDGET_MS),
    );
    let started = std::time::Instant::now();
    let expired = || started.elapsed() >= budget;
    let matcher = build_matcher(query, use_regex, case_sensitive)?;
    // What git ignores (generated output, virtualenvs, caches) is skipped like the heavy folders
    // is_ignored_path already skips, unless the caller asks for ignored files too.
    let gitignore = if include_ignored {
        GitignoreRules::default()
    } else {
        GitignoreRules::load(ws.root(), &resolved.path)
    };

    let mut matches = Vec::new();
    let mut warnings = Vec::new();
    let mut skipped_large = 0usize;
    let mut skipped_binary = 0usize;
    let mut files_searched = 0usize;

    let mut consider_file = |p: &Path| {
        if matches.len() >= max_results {
            return SearchStop::ResultLimit;
        }
        if expired() {
            return SearchStop::Deadline;
        }
        if !ws.is_safe_read_path(p) {
            return SearchStop::Complete;
        }
        if ws.is_ignored_path(p, false, include_ignored) {
            return SearchStop::Complete;
        }
        files_searched += 1;
        let rel = ws.display_path(p);
        if !passes_glob_filters(&rel, &include_globs, &exclude_globs) {
            return SearchStop::Complete;
        }
        let meta = match p.metadata() {
            Ok(m) if m.is_file() => m,
            _ => return SearchStop::Complete,
        };
        if meta.len() > max_file_bytes {
            skipped_large += 1;
            return SearchStop::Complete;
        }
        match file_text_eligibility(p) {
            FileEligibility::Binary => {
                skipped_binary += 1;
                return SearchStop::Complete;
            }
            FileEligibility::Unreadable => return SearchStop::Complete,
            FileEligibility::Text => {}
        }
        search_file_streaming(
            p,
            &rel,
            &matcher,
            context_lines,
            max_preview,
            max_results,
            &mut matches,
            &expired,
        )
    };

    let mut stop = if resolved.path.is_file() {
        consider_file(&resolved.path)
    } else {
        // Ignored and hidden directories are pruned whole, matching the per-file rule below.
        walk_search_files(
            &resolved.path,
            |entry| {
                entry.path() != resolved.path
                    && ((entry.file_type().is_dir()
                        && ws.is_ignored_path(entry.path(), false, include_ignored))
                        || gitignore.ignores(entry.path(), entry.file_type().is_dir()))
            },
            &mut consider_file,
            &expired,
        )
    };
    if stop == SearchStop::Complete && expired() {
        stop = SearchStop::Deadline;
    }
    let mut truncated = stop == SearchStop::ResultLimit;
    let timed_out = stop == SearchStop::Deadline;

    if truncated {
        warnings.push("result limit reached; scan stopped early".to_string());
    }
    if timed_out {
        truncated = true;
        warnings.push(format!(
            "search time budget of {} ms reached with partial results ({files_searched} file(s) searched); \
             narrow it with path or include_globs",
            budget.as_millis()
        ));
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
        "timed_out": timed_out,
        "files_searched": files_searched,
        "max_file_bytes": max_file_bytes,
        "skipped_large_files": skipped_large,
        "skipped_binary_files": skipped_binary,
        "warnings": warnings
    })))
}

/// The `.gitignore` rules `search_text` honours: those of the workspace root and of the folder
/// being searched (and each folder between them), as git reads them for that tree. Patterns are
/// matched with git's main rules (a pattern without a slash matches a name at any depth, one with
/// a slash is anchored to its `.gitignore`'s folder, a trailing slash matches only folders, `!`
/// re-includes). Nested `.gitignore` files below the searched folder are not read.
#[derive(Default)]
struct GitignoreRules {
    rules: Vec<GitignoreRule>,
}

struct GitignoreRule {
    base: std::path::PathBuf,
    pattern: glob::Pattern,
    anchored: bool,
    dir_only: bool,
    negated: bool,
}

impl GitignoreRules {
    fn load(workspace_root: &Path, search_root: &Path) -> Self {
        let mut folders = Vec::new();
        let mut cursor = Some(search_root);
        while let Some(folder) = cursor {
            folders.push(folder.to_path_buf());
            if folder == workspace_root || !folder.starts_with(workspace_root) {
                break;
            }
            cursor = folder.parent();
        }
        folders.reverse();
        let mut rules = Vec::new();
        for folder in folders {
            let Ok(text) = fs::read_to_string(folder.join(".gitignore")) else {
                continue;
            };
            for line in text.lines() {
                let line = line.trim_end();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let (negated, line) = match line.strip_prefix('!') {
                    Some(rest) => (true, rest),
                    None => (false, line.strip_prefix('\\').unwrap_or(line)),
                };
                let dir_only = line.ends_with('/');
                let body = line.trim_end_matches('/');
                let anchored = body.contains('/');
                let body = body.trim_start_matches('/');
                if body.is_empty() {
                    continue;
                }
                let Ok(pattern) = glob::Pattern::new(body) else {
                    continue;
                };
                rules.push(GitignoreRule {
                    base: folder.clone(),
                    pattern,
                    anchored,
                    dir_only,
                    negated,
                });
            }
        }
        Self { rules }
    }

    /// Whether git would ignore `path` (a folder when `is_dir`). The walk prunes ignored folders,
    /// so a path's ancestors were already checked.
    fn ignores(&self, path: &Path, is_dir: bool) -> bool {
        let options = glob::MatchOptions {
            case_sensitive: !cfg!(windows),
            require_literal_separator: true,
            require_literal_leading_dot: false,
        };
        let mut ignored = false;
        for rule in &self.rules {
            if rule.dir_only && !is_dir {
                continue;
            }
            let Ok(relative) = path.strip_prefix(&rule.base) else {
                continue;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            if relative.is_empty() {
                continue;
            }
            let hit = if rule.anchored {
                rule.pattern.matches_with(&relative, options)
            } else {
                let name = relative.rsplit('/').next().unwrap_or(&relative);
                rule.pattern.matches_with(name, options)
            };
            if hit {
                ignored = !rule.negated;
            }
        }
        ignored
    }
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

/// Stream a file line-by-line, retaining the reason a scan stops early.
#[allow(clippy::too_many_arguments)]
fn search_file_streaming(
    path: &Path,
    rel: &str,
    matcher: &Matcher,
    context_lines: usize,
    max_preview: usize,
    max_results: usize,
    matches: &mut Vec<Value>,
    expired: &dyn Fn() -> bool,
) -> SearchStop {
    if expired() {
        return SearchStop::Deadline;
    }
    let opened = File::open(path);
    if expired() {
        return SearchStop::Deadline;
    }
    let file = match opened {
        Ok(f) => f,
        Err(_) => return SearchStop::Complete,
    };
    search_reader_streaming(
        BufReader::new(file),
        rel,
        matcher,
        context_lines,
        max_preview,
        max_results,
        matches,
        expired,
    )
}

#[allow(clippy::too_many_arguments)]
fn search_reader_streaming(
    mut reader: impl BufRead,
    rel: &str,
    matcher: &Matcher,
    context_lines: usize,
    max_preview: usize,
    max_results: usize,
    matches: &mut Vec<Value>,
    expired: &dyn Fn() -> bool,
) -> SearchStop {
    let mut recent: VecDeque<String> = VecDeque::with_capacity(context_lines.max(1));
    let mut pending: Vec<PendingMatch> = Vec::new();
    let mut line_no = 0usize;
    let mut raw = Vec::new();

    'lines: loop {
        raw.clear();
        loop {
            if expired() {
                flush_pending(&mut pending, matches, max_results);
                return SearchStop::Deadline;
            }
            // Keep a logical line intact for UTF-8, anchors and context, but check the
            // deadline between bounded reads. A blocked OS read cannot be preempted here.
            let read = (&mut reader)
                .take(SEARCH_READ_CHUNK_BYTES)
                .read_until(b'\n', &mut raw);
            if expired() {
                flush_pending(&mut pending, matches, max_results);
                return SearchStop::Deadline;
            }
            match read {
                Ok(0) if raw.is_empty() => break 'lines,
                Ok(0) => break,
                Ok(_) if raw.last() == Some(&b'\n') => break,
                Ok(_) => continue,
                Err(_) => {
                    flush_pending(&mut pending, matches, max_results);
                    return if matches.len() >= max_results {
                        SearchStop::ResultLimit
                    } else {
                        SearchStop::Complete
                    };
                }
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
                    return SearchStop::ResultLimit;
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
                    return SearchStop::ResultLimit;
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
            return SearchStop::ResultLimit;
        }
    }
    SearchStop::Complete
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
        let rel = if display.is_empty() || display == "." {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::io::{self, Cursor};

    struct ControlledReader<'a> {
        inner: Cursor<Vec<u8>>,
        consumed: &'a Cell<usize>,
        largest_read: &'a Cell<usize>,
        fail_after: Option<usize>,
    }

    impl Read for ControlledReader<'_> {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            let available = self.fill_buf()?;
            let count = bytes.len().min(available.len());
            bytes[..count].copy_from_slice(&available[..count]);
            self.consume(count);
            Ok(count)
        }
    }

    impl BufRead for ControlledReader<'_> {
        fn fill_buf(&mut self) -> io::Result<&[u8]> {
            let position = self.inner.position() as usize;
            if self.fail_after.is_some_and(|limit| position >= limit) {
                return Err(io::Error::other("controlled read failure"));
            }
            let available = self.inner.fill_buf()?;
            let length = self.fail_after.map_or(available.len(), |limit| {
                available.len().min(limit - position)
            });
            Ok(&available[..length])
        }

        fn consume(&mut self, count: usize) {
            self.inner.consume(count);
            self.consumed.set(self.consumed.get() + count);
            self.largest_read.set(self.largest_read.get().max(count));
        }
    }

    #[test]
    fn read_file_fitter_preserves_owned_bytes_and_metadata() {
        let decorate = |mut value: Value| {
            value["project_instructions"] = json!({"instructions":"keep this rule","revision":"r"});
            value["project_scope"] = json!({"root":".","workspace_id":"fixture"});
            value["server_dispatch_ms"] = json!(u64::MAX);
            value
        };
        for raw in [
            b"\x80\xbfX\xff\r\n".repeat(1024),
            "界🙂\r\n".repeat(1024).into_bytes(),
        ] {
            let mut source = b"skip\r\n".to_vec();
            source.extend_from_slice(&raw);
            let page = ReadFilePage {
                window: read_window(Cursor::new(&source), 0, None, 2, None, 128 * 1024).unwrap(),
                path: "fixture.txt".into(),
                encoding: "utf-8",
                total_bytes: source.len() as u64,
                total_lines: Some(count_lines(source.as_slice()).unwrap()),
                warnings: Vec::new(),
                requested_max: None,
            };
            let original = decorate(page.value());
            assert!(serde_json::to_vec(&original).unwrap().len() > 2048);
            let fitted = page.fit_result(original.clone(), 2048);
            assert_eq!(fitted["ok"], true);
            assert!(serde_json::to_vec(&fitted).unwrap().len() <= 2048);
            for key in [
                "project_instructions",
                "project_scope",
                "server_dispatch_ms",
            ] {
                assert_eq!(fitted[key], original[key]);
            }
            let consumed = fitted["bytes_read"].as_u64().unwrap() as usize;
            assert!(consumed > 0 && consumed < raw.len());
            assert_eq!(fitted["offset"], 6);
            assert_eq!(fitted["next_offset"], (6 + consumed) as u64);
            assert_eq!(fitted["start_line"], 2);
            assert_eq!(
                fitted["content"],
                String::from_utf8_lossy(&raw[..consumed]).as_ref()
            );
            assert_eq!(
                fitted["end_line"],
                (1 + count_lines(&raw[..consumed]).unwrap()) as u64
            );
            assert_eq!(fitted["cut_mid_line"], raw[consumed - 1] != b'\n');
            assert_eq!(fitted["truncated"], true);
        }

        let small = || ReadFilePage {
            window: read_window(Cursor::new(b"ok\n"), 0, None, 1, None, 4).unwrap(),
            path: "small.txt".into(),
            encoding: "utf-8",
            total_bytes: 3,
            total_lines: Some(1),
            warnings: Vec::new(),
            requested_max: None,
        };
        let original = decorate(small().value());
        let exact = serde_json::to_vec(&original).unwrap().len();
        assert_eq!(small().fit_result(original.clone(), exact), original);
        for limit in [0, exact - 1] {
            let failed = small().fit_result(original.clone(), limit);
            assert_eq!(failed["ok"], false);
            assert_eq!(failed["error"]["code"], "RESULT_TOO_LARGE");
            assert!(failed.get("content").is_none());
            assert!(failed.get("next_offset").is_none());
            assert_eq!(
                failed["project_instructions"],
                original["project_instructions"]
            );
        }
        let mut irreducible = original.clone();
        irreducible["project_instructions"]["instructions"] = json!("x".repeat(4096));
        let failed = small().fit_result(irreducible.clone(), 2048);
        assert_eq!(failed["ok"], false);
        assert_eq!(
            failed["project_instructions"],
            irreducible["project_instructions"]
        );
        assert!(serde_json::to_vec(&failed).unwrap().len() > 2048);
        assert!(failed.get("next_offset").is_none());

        let raw = "🙂".repeat(16).into_bytes();
        let page = ReadFilePage {
            window: read_window(Cursor::new(&raw), 0, None, 1, None, raw.len()).unwrap(),
            path: "emoji.txt".into(),
            encoding: "utf-8",
            total_bytes: raw.len() as u64,
            total_lines: Some(1),
            warnings: Vec::new(),
            requested_max: None,
        };
        let minimum = read_window(Cursor::new(&raw), 0, None, 1, None, 4).unwrap();
        let exact = serde_json::to_vec(&decorate(page.value_for(&minimum)))
            .unwrap()
            .len();
        let original = decorate(page.value());
        let fitted = page.fit_result(original, exact);
        assert_eq!(fitted["ok"], true);
        assert_eq!(fitted["content"], "🙂");
        assert_eq!(fitted["bytes_read"], 4);
        assert_eq!(fitted["next_offset"], 4);
        assert_eq!(serde_json::to_vec(&fitted).unwrap().len(), exact);
    }

    #[test]
    fn read_file_shared_result_fits_with_instructions_and_raw_cursors() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../aiTemp/read-file-budget-tests");
        fs::create_dir_all(&base).unwrap();
        let tree = tempfile::Builder::new()
            .prefix("shared-")
            .tempdir_in(&base)
            .unwrap();
        let root = tree.path().join("project");
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("AGENTS.md"), "\u{1}".repeat(16 * 1024)).unwrap();
        fs::write(root.join("nested/agent.md"), "\u{1}".repeat(16 * 1024)).unwrap();
        let ctx =
            crate::tools::ToolContext::for_test(root.clone(), tree.path().join("harness")).unwrap();
        let wide = "界🙂\r\n".repeat(20_000);
        let mut utf16 = vec![0xff, 0xfe];
        for unit in wide.encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        let cases = [
            ("control.txt", b"\x01\r\n".repeat(44_000), None, None),
            (
                "quotes.txt",
                vec![b'"'; 192 * 1024 + 64],
                Some(192 * 1024),
                None,
            ),
            ("invalid.txt", vec![0xff; 128 * 1024 + 64], None, None),
            ("wide.txt", utf16, None, Some(wide)),
        ];
        for (name, source, maximum, decoded) in cases {
            let path = format!("nested/{name}");
            fs::write(root.join(&path), &source).unwrap();
            let expected = decoded.unwrap_or_else(|| String::from_utf8_lossy(&source).into_owned());
            let total_bytes = if name == "wide.txt" {
                expected.len()
            } else {
                source.len()
            };
            let instructions =
                crate::tools::project_context::for_tool(&ctx, "read_file", &json!({"path":path}));
            let mut offset = 0u64;
            let mut joined = String::new();
            for page_index in 0..128 {
                let mut args = json!({"path":path,"offset":offset});
                if let Some(maximum) = maximum {
                    args["max_bytes"] = json!(maximum);
                }
                let value = crate::tools::call_tool(&ctx, "read_file", &args);
                assert_eq!(value["ok"], true);
                assert!(
                    serde_json::to_vec(&value).unwrap().len()
                        <= crate::tools::workspace::MAX_SERIALIZED_TOOL_RESULT_BYTES
                );
                assert_eq!(value["project_instructions"], instructions);
                assert!(value["project_scope"].is_object());
                assert!(value["server_dispatch_ms"].is_number());
                assert_eq!(value["offset"], offset);
                assert_eq!(value["total_bytes"], total_bytes as u64);
                joined.push_str(value["content"].as_str().unwrap());
                if let Some(next) = value["next_offset"].as_u64() {
                    assert!(next > offset);
                    assert_eq!(next - offset, value["bytes_read"].as_u64().unwrap());
                    offset = next;
                    assert!(page_index < 127, "paging did not finish");
                } else {
                    assert_eq!(
                        offset + value["bytes_read"].as_u64().unwrap(),
                        total_bytes as u64
                    );
                    break;
                }
            }
            assert_eq!(joined, expected);
            let acknowledged = crate::tools::dispatch::call_tool_mcp(
                &ctx,
                "read_file",
                &json!({"path":path,"max_bytes":4,"known_project_instructions_revision":instructions["revision"]}),
            );
            assert_eq!(acknowledged["ok"], true);
            assert_eq!(acknowledged["project_instructions"]["instructions"], "");
            assert_eq!(acknowledged["project_instructions"]["unchanged"], true);
            assert_eq!(
                acknowledged["project_instructions"]["revision"],
                instructions["revision"]
            );
        }
        fs::write(root.join("small.txt"), b"ok\n").unwrap();
        let direct = read_file(&ctx.workspace, &json!({"path":"small.txt"})).unwrap();
        let shared = crate::tools::call_tool(&ctx, "read_file", &json!({"path":"small.txt"}));
        for (key, value) in direct.as_object().unwrap() {
            assert_eq!(&shared[key], value);
        }
        assert_eq!(direct["content"], "ok\n");
        assert_eq!(direct["bytes_read"], 3);
    }

    #[test]
    fn search_deadline_discards_unfinished_line_and_keeps_pending_context() {
        let first = b"first needle\n";
        let mut text = first.to_vec();
        text.extend_from_slice(b"needle ");
        text.extend(std::iter::repeat_n(b'x', SEARCH_READ_CHUNK_BYTES as usize));
        text.extend_from_slice(b" end\n");
        let consumed = Cell::new(0);
        let largest_read = Cell::new(0);
        let reader = ControlledReader {
            inner: Cursor::new(text),
            consumed: &consumed,
            largest_read: &largest_read,
            fail_after: None,
        };
        let mut matches = Vec::new();
        let stop = search_reader_streaming(
            reader,
            "log.txt",
            &Matcher::Exact("needle".into()),
            2,
            64,
            10,
            &mut matches,
            &|| consumed.get() >= first.len() + SEARCH_READ_CHUNK_BYTES as usize,
        );
        assert_eq!(stop, SearchStop::Deadline);
        assert_eq!(
            consumed.get(),
            first.len() + SEARCH_READ_CHUNK_BYTES as usize
        );
        assert!(largest_read.get() <= SEARCH_READ_CHUNK_BYTES as usize);
        assert_eq!(
            matches,
            vec![json!({"path":"log.txt","line":1,"column":1,
            "preview":"first needle","before":[],"after":[]})]
        );

        let mut matches = Vec::new();
        let mut reader = Cursor::new(b"needle\n".to_vec());
        assert_eq!(
            search_reader_streaming(
                &mut reader,
                "log.txt",
                &Matcher::Exact("needle".into()),
                0,
                64,
                10,
                &mut matches,
                &|| true
            ),
            SearchStop::Deadline
        );
        assert_eq!(reader.position(), 0);
        assert!(matches.is_empty());
    }

    #[test]
    fn search_chunks_preserve_lines_context_utf8_errors_and_limit_reason() {
        let mut text = b"before\r\n".to_vec();
        text.extend(std::iter::repeat_n(
            b'x',
            SEARCH_READ_CHUNK_BYTES as usize - 1,
        ));
        text.extend_from_slice("é\r\nafter\r\nbad".as_bytes());
        text.push(0xff);
        let matcher = build_matcher("^(x+é|bad�)$", true, true).unwrap();
        let mut matches = Vec::new();
        assert_eq!(
            search_reader_streaming(
                Cursor::new(&text),
                "text",
                &matcher,
                1,
                12,
                10,
                &mut matches,
                &|| false
            ),
            SearchStop::Complete
        );
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0]["line"], 2);
        assert_eq!(matches[0]["preview"], "xxxxxxxxxxxx...");
        assert_eq!(matches[0]["before"], json!(["before"]));
        assert_eq!(matches[0]["after"], json!(["after"]));
        assert_eq!(matches[1]["line"], 4);
        assert_eq!(matches[1]["preview"], "bad�");
        assert_eq!(matches[1]["before"], json!(["after"]));
        assert_eq!(matches[1]["after"], json!([]));

        let mut limited = Vec::new();
        assert_eq!(
            search_reader_streaming(
                Cursor::new(&text),
                "text",
                &matcher,
                1,
                12,
                1,
                &mut limited,
                &|| false
            ),
            SearchStop::ResultLimit
        );
        assert_eq!(limited, matches[..1]);

        let consumed = Cell::new(0);
        let largest_read = Cell::new(0);
        let first = b"first needle\n";
        let reader = ControlledReader {
            inner: Cursor::new(b"first needle\nunfinished needle\n".to_vec()),
            consumed: &consumed,
            largest_read: &largest_read,
            fail_after: Some(first.len() + 4),
        };
        let mut partial = Vec::new();
        assert_eq!(
            search_reader_streaming(
                reader,
                "text",
                &Matcher::Exact("needle".into()),
                2,
                64,
                10,
                &mut partial,
                &|| false
            ),
            SearchStop::Complete
        );
        assert_eq!(
            partial,
            vec![json!({"path":"text","line":1,"column":1,
            "preview":"first needle","before":[],"after":[]})]
        );
    }

    #[test]
    fn search_walk_checks_deadline_through_directory_only_and_pruned_entries() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../aiTemp/search-deadline-tests");
        fs::create_dir_all(&base).unwrap();
        let tree = tempfile::Builder::new()
            .prefix("walk-")
            .tempdir_in(&base)
            .unwrap();
        for name in ["one", "two"] {
            fs::create_dir_all(tree.path().join(name).join("child")).unwrap();
            fs::write(tree.path().join(name).join("unseen.txt"), "needle").unwrap();
        }
        let visited = Cell::new(0);
        let checks = Cell::new(0);
        let stop = walk_search_files(
            tree.path(),
            |entry| entry.path() != tree.path(),
            |_| {
                visited.set(visited.get() + 1);
                SearchStop::Complete
            },
            &|| {
                checks.set(checks.get() + 1);
                checks.get() >= 6
            },
        );
        assert_eq!(stop, SearchStop::Deadline);
        assert_eq!(visited.get(), 0);
        assert_eq!(
            walk_search_files(
                tree.path(),
                |entry| entry.path() != tree.path(),
                |_| {
                    visited.set(visited.get() + 1);
                    SearchStop::Complete
                },
                &|| false
            ),
            SearchStop::Complete
        );
        assert_eq!(visited.get(), 0);

        for name in ["eligible-a.txt", "eligible-b.txt"] {
            fs::write(tree.path().join(name), "needle").unwrap();
        }
        let ignored = std::cell::RefCell::new(None);
        let mut files = Vec::new();
        assert_eq!(
            walk_search_files(
                tree.path(),
                |entry| {
                    if entry.depth() == 1 && entry.file_type().is_file() {
                        let mut ignored = ignored.borrow_mut();
                        if ignored.is_none() {
                            *ignored = Some(entry.path().to_path_buf());
                            return true;
                        }
                    }
                    false
                },
                |path| {
                    files.push(path.to_path_buf());
                    SearchStop::Complete
                },
                &|| false,
            ),
            SearchStop::Complete
        );
        let ignored = ignored.into_inner().expect("one root file was ignored");
        assert_eq!(files.len(), 3);
        assert!(!files.contains(&ignored));
        for expected in [
            tree.path().join("one").join("unseen.txt"),
            tree.path().join("two").join("unseen.txt"),
            tree.path().join("eligible-a.txt"),
            tree.path().join("eligible-b.txt"),
        ] {
            if expected != ignored {
                assert!(
                    files.contains(&expected),
                    "eligible sibling missing: {expected:?}"
                );
            }
        }
    }
}
