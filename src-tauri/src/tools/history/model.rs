use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryIndex {
    pub version: u32,
    pub latest_number: u64,
    pub sessions: BTreeMap<String, IndexEntry>,
}

impl Default for HistoryIndex {
    fn default() -> Self {
        Self {
            version: 1,
            latest_number: 0,
            sessions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexEntry {
    pub number: u64,
    pub path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct HistoryDocument {
    pub number: u64,
    pub path: String,
    pub content: String,
    pub session_key: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ScanReport {
    pub documents: Vec<HistoryDocument>,
    pub numbers: Vec<u64>,
    pub missing_numbers: Vec<u64>,
    pub missing_number_count: u64,
    pub duplicate_session_keys: Vec<String>,
    pub invalid_files: Vec<String>,
    pub empty_files: Vec<String>,
}

impl ScanReport {
    pub fn latest_number(&self) -> Option<u64> {
        self.numbers.last().copied()
    }

    pub fn sequence_valid(&self) -> bool {
        self.missing_numbers.is_empty()
            && self.duplicate_session_keys.is_empty()
            && self.invalid_files.is_empty()
            && self.empty_files.is_empty()
    }

    pub fn total_bytes(&self) -> u64 {
        self.documents
            .iter()
            .map(|document| document.content.len() as u64)
            .sum()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointRecord {
    pub turn_id: String,
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub user_intent: String,
    #[serde(default)]
    pub raw_user_input: String,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub supersedes: Option<String>,
    #[serde(default)]
    pub content_hash: String,
    #[serde(default)]
    pub findings: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub files_changed: Vec<String>,
    #[serde(default)]
    pub tests: Vec<String>,
    #[serde(default)]
    pub runtime_state: Vec<String>,
    #[serde(default)]
    pub remaining_issues: Vec<String>,
    #[serde(default)]
    pub next_actions: Vec<String>,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InitialInputRecord {
    pub raw_user_input: String,
    pub captured_at: String,
    pub revision: u64,
    #[serde(default)]
    pub supersedes: Option<String>,
    #[serde(default)]
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub number: u64,
    pub path: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(default)]
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemoryManifest {
    pub version: u32,
    pub archive_revision: String,
    #[serde(default)]
    pub entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryReference {
    pub number: u64,
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryState {
    pub version: u32,
    pub state_revision: u64,
    pub archive_revision: String,
    pub generated_at: String,
    pub current_session: Option<MemoryReference>,
    #[serde(default)]
    pub current_focus: String,
    #[serde(default)]
    pub recent_changes: Vec<String>,
    #[serde(default)]
    pub open_items: Vec<String>,
    #[serde(default)]
    pub references: Vec<MemoryReference>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub number: u64,
    pub path: String,
    pub title: String,
    pub updated_at: String,
    pub sha256: String,
    pub score: u64,
    pub snippet: String,
}
