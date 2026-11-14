//! Bounded, incremental model-identity reads from explicitly linked sessions.
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const BUDGET: u64 = 64 * 1024 * 1024;
const ENTRIES: usize = 1024;

#[derive(Default)]
pub(super) struct Sessions {
    cache: BTreeMap<PathBuf, Checkpoint>,
    remaining: u64,
}
#[derive(Clone)]
struct Checkpoint {
    prefix: Vec<u8>,
    created: Option<SystemTime>,
    modified: Option<SystemTime>,
    len: u64,
    offset: u64,
    id: String,
    model: Option<String>,
}
#[derive(Deserialize)]
struct Event {
    #[serde(rename = "type")]
    kind: String,
    id: Option<String>,
    version: Option<u64>,
    provider: Option<String>,
    #[serde(rename = "modelId")]
    model: Option<String>,
}
impl Sessions {
    pub(super) fn begin(&mut self) {
        self.remaining = BUDGET;
    }
    pub(super) fn model(&mut self, directory: &Path, session: &str) -> Result<String, String> {
        if !super::safe_id(session) {
            return Err("unsafe session ID".into());
        }
        let suffix = format!("_{session}.jsonl");
        let entries = fs::read_dir(directory).map_err(|_| "session directory unavailable")?;
        let mut paths = Vec::new();
        for (n, entry) in entries.take(ENTRIES + 1).enumerate() {
            if n == ENTRIES {
                return Err("session directory entry limit exceeded".into());
            }
            let entry = entry.map_err(|_| "session directory unavailable")?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(&suffix))
            {
                paths.push(entry.path());
            }
        }
        if paths.len() != 1 {
            return Err(if paths.is_empty() {
                "linked session log missing"
            } else {
                "ambiguous session logs"
            }
            .into());
        }
        self.read(&paths[0], session)
    }
    pub(super) fn discover(&mut self, directory: &Path) -> Result<(String, String), String> {
        let entries =
            fs::read_dir(directory).map_err(|_| "worker session directory unavailable")?;
        let mut paths = Vec::new();
        for (n, entry) in entries.take(ENTRIES + 1).enumerate() {
            if n == ENTRIES {
                return Err("session directory entry limit exceeded".into());
            }
            let entry = entry.map_err(|_| "worker session directory unavailable")?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(".jsonl"))
            {
                paths.push(entry.path());
            }
        }
        if paths.len() != 1 {
            return Err("worker session log missing or ambiguous".into());
        }
        let id = paths[0]
            .file_stem()
            .and_then(|name| name.to_str())
            .and_then(|name| name.rsplit_once('_'))
            .map(|(_, id)| id.to_owned())
            .ok_or("unsupported worker session filename")?;
        if !super::safe_id(&id) {
            return Err("unsafe worker session ID".into());
        }
        let model = self.read(&paths[0], &id)?;
        Ok((id, model))
    }

    fn read(&mut self, path: &Path, session: &str) -> Result<String, String> {
        let meta = fs::symlink_metadata(path).map_err(|_| "session log unavailable")?;
        if !meta.is_file() {
            return Err("session log is not a regular file".into());
        }
        let mut file = fs::File::open(path).map_err(|_| "session log unavailable")?;
        let mut prefix = Vec::new();
        file.by_ref()
            .take(4096)
            .read_to_end(&mut prefix)
            .map_err(|_| "session prefix unreadable")?;
        let old = self.cache.remove(path).filter(|old| {
            old.id == session
                && old.prefix == prefix
                && old.created == meta.created().ok()
                && old.offset <= meta.len()
                && (old.len != meta.len() || old.modified == meta.modified().ok())
        });
        if let Some(old) = old.as_ref() {
            if old.len == meta.len()
                && old.modified == meta.modified().ok()
                && old.offset == old.len
            {
                let model = old.model.clone();
                self.cache.insert(path.into(), old.clone());
                return model.ok_or_else(|| "session has no model record".into());
            }
        }
        let mut checkpoint = old.unwrap_or(Checkpoint {
            prefix,
            created: meta.created().ok(),
            modified: None,
            len: 0,
            offset: 0,
            id: session.into(),
            model: None,
        });
        let size = meta.len().saturating_sub(checkpoint.offset);
        let read_size = size.min(self.remaining);
        if read_size == 0 && size > 0 {
            // Other beads may reference this same owner after the collection
            // budget is exhausted. Keep progress for the next collection.
            self.cache.insert(path.into(), checkpoint);
            return Err("session read budget exceeded".into());
        }
        self.remaining -= read_size;
        file.seek(SeekFrom::Start(checkpoint.offset))
            .map_err(|_| "session seek failed")?;
        let mut bytes = Vec::new();
        file.take(read_size)
            .read_to_end(&mut bytes)
            .map_err(|_| "session log unreadable")?;
        for line in bytes.split_inclusive(|b| *b == b'\n') {
            if !line.ends_with(b"\n") {
                break;
            }
            let event: Event =
                serde_json::from_slice(line).map_err(|_| "malformed session record")?;
            if event.kind == "session" && checkpoint.offset != 0 {
                return Err("multiple session headers in one log".into());
            }
            if checkpoint.offset == 0
                && (event.kind != "session"
                    || event.id.as_deref() != Some(session)
                    || event.version != Some(3))
            {
                return Err("session header ID or format mismatch".into());
            }
            if event.kind == "model_change" {
                checkpoint.model = match (event.provider, event.model) {
                    (Some(provider), Some(model)) if !provider.is_empty() && !model.is_empty() => {
                        Some(super::bounded(format!("{provider}/{model}")))
                    }
                    _ => return Err("session model record incomplete".into()),
                };
            }
            checkpoint.offset += line.len() as u64;
        }
        checkpoint.modified = meta.modified().ok();
        checkpoint.len = meta.len();
        let model = checkpoint.model.clone();
        if self.cache.len() >= 256 {
            self.cache.clear();
        }
        self.cache.insert(path.into(), checkpoint);
        if read_size < size {
            return Err("session scan continues within the next collection budget".into());
        }
        model.ok_or_else(|| "session has no model record".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bdi-session-identity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
    fn log(id: &str, model: &str) -> String {
        format!(
            "{}\n{}\n{}\n",
            serde_json::json!({"type":"session","version":3,"id":id}),
            serde_json::json!({"type":"model_change","provider":"invented","modelId":model}),
            serde_json::json!({"type":"message","message":"x".repeat(6000)})
        )
    }
    #[test]
    fn shared_owner_lookups_preserve_progress_after_budget_exhaustion() {
        let dir = directory();
        let path = dir.join("invented_session-a.jsonl");
        fs::write(&path, log("session-a", "first-model")).unwrap();
        let mut reader = Sessions {
            remaining: 250,
            ..Default::default()
        };
        assert!(reader.model(&dir, "session-a").is_err());
        let offset = reader.cache[&path].offset;
        assert!(offset > 0);
        assert!(reader.model(&dir, "session-a").is_err());
        assert_eq!(reader.cache[&path].offset, offset);
        reader.begin();
        assert_eq!(
            reader.model(&dir, "session-a").unwrap(),
            "invented/first-model"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn linked_identity_is_cached_and_complete_appends_change_the_model() {
        let dir = directory();
        let path = dir.join("invented_session-a.jsonl");
        fs::write(&path, log("session-a", "first-model")).unwrap();
        let mut reader = Sessions::default();
        reader.begin();
        assert_eq!(
            reader.model(&dir, "session-a").unwrap(),
            "invented/first-model"
        );
        reader.remaining = 0;
        assert_eq!(
            reader.model(&dir, "session-a").unwrap(),
            "invented/first-model",
            "unchanged logs need no body read"
        );
        use std::io::Write;
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(
            file,
            "{{\"type\":\"model_change\",\"provider\":\"invented\",\"modelId\":\"second"
        )
        .unwrap();
        reader.begin();
        assert_eq!(
            reader.model(&dir, "session-a").unwrap(),
            "invented/first-model",
            "partial appends do not replace a completed checkpoint"
        );
        writeln!(file, "-model\"}}").unwrap();
        reader.begin();
        assert_eq!(
            reader.model(&dir, "session-a").unwrap(),
            "invented/second-model"
        );
        assert!(
            reader.remaining > BUDGET - 512,
            "only the small append should be read"
        );
        fs::write(&path, log("session-a", "replacement-model")).unwrap();
        reader.begin();
        assert_eq!(
            reader.model(&dir, "session-a").unwrap(),
            "invented/replacement-model"
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn bounded_initial_scan_defers_identity_until_later_model_changes_are_read() {
        let dir = directory();
        let path = dir.join("invented_session-a.jsonl");
        let content = format!(
            "{}{}\n",
            log("session-a", "first-model"),
            serde_json::json!({"type":"model_change","provider":"invented","modelId":"latest-model"})
        );
        fs::write(&path, content).unwrap();
        let mut reader = Sessions {
            remaining: 180,
            ..Default::default()
        };
        assert!(reader
            .model(&dir, "session-a")
            .unwrap_err()
            .contains("next collection"));
        reader.begin();
        assert_eq!(
            reader.model(&dir, "session-a").unwrap(),
            "invented/latest-model"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_ambiguous_wrong_session_and_budget_limits_do_not_guess() {
        let dir = directory();
        let path = dir.join("invented_session-a.jsonl");
        let mut reader = Sessions::default();
        reader.begin();
        assert!(reader.model(&dir, "../session-a").is_err());
        assert!(reader.model(&dir, "session-a").is_err());
        fs::write(&path, log("different-session", "wrong-model")).unwrap();
        assert!(reader
            .model(&dir, "session-a")
            .unwrap_err()
            .contains("mismatch"));
        fs::write(&path, log("session-a", "first-model")).unwrap();
        reader.remaining = 0;
        assert!(reader
            .model(&dir, "session-a")
            .unwrap_err()
            .contains("budget"));
        reader.begin();
        assert!(reader.model(&dir, "session-a").is_ok());
        fs::write(
            dir.join("other_session-a.jsonl"),
            log("session-a", "other-model"),
        )
        .unwrap();
        assert!(reader
            .model(&dir, "session-a")
            .unwrap_err()
            .contains("ambiguous"));
        fs::remove_dir_all(dir).unwrap();
    }
}
