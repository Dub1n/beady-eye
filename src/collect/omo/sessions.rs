//! Identity verification and bounded model metadata for explicitly linked sessions.
//! Conversation fields are discarded with IgnoredAny; no message text survives a read.
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const ENTRIES: usize = 1024;
const MAX_HEADER_BYTES: usize = 4096;

#[derive(Default)]
pub(super) struct Sessions {
    scans: BTreeMap<(PathBuf, String), Scan>,
    budget: u64,
    generation: u64,
}
struct Scan {
    metadata: fs::Metadata,
    offset: u64,
    model: Option<String>,
    complete: bool,
    generation: u64,
}

#[derive(Deserialize)]
struct Header {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    version: u64,
}

const MAX_MODEL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_COLLECTION_BYTES: u64 = 32 * 1024 * 1024;
const MAX_LINE_BYTES: u64 = 1024 * 1024;

#[derive(Deserialize)]
struct ModelRecord<'a> {
    #[serde(rename = "type", borrow)]
    kind: &'a str,
    #[serde(borrow)]
    provider: Option<&'a str>,
    #[serde(rename = "modelId", borrow)]
    model_id: Option<&'a str>,
    #[serde(default, rename = "message")]
    _message: Option<serde::de::IgnoredAny>,
    // Serde also discards every unknown field using IgnoredAny.
}

impl Sessions {
    pub(super) fn verify(&mut self, directory: &Path, session: &str) -> Result<(), String> {
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
    pub(super) fn begin_collection(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.budget = MAX_COLLECTION_BYTES;
        // Keep only recently linked sessions, bounding both metadata and models.
        self.scans
            .retain(|_, scan| scan.generation == self.generation.wrapping_sub(1));
    }

    /// Scan only linked, header-verified logs. Incomplete scans retain metadata
    /// and offsets, never text, and expose no model until reaching the log tail.
    /// Any file mutation invalidates progress rather than trusting a stale prefix.
    pub(super) fn model(&mut self, directory: &Path, session: &str) -> Option<String> {
        self.verify(directory, session).ok()?;
        let suffix = format!("_{session}.jsonl");
        let path = fs::read_dir(directory)
            .ok()?
            .take(ENTRIES)
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.ends_with(&suffix))
            })?
            .path();
        let meta = fs::symlink_metadata(&path).ok()?;
        if !meta.is_file() {
            return None;
        }
        let mut file = fs::File::open(&path).ok()?;
        let opened = file.metadata().ok()?;
        if !same_file(&meta, &opened) {
            return None;
        }
        verify_header(&mut file, session).ok()?;
        let header_end = file.stream_position().ok()?;
        let key = (path.clone(), session.to_owned());
        if self
            .scans
            .get(&key)
            .is_some_and(|scan| !same_file(&scan.metadata, &opened))
        {
            self.scans.remove(&key);
        }
        if !self.scans.contains_key(&key) && self.scans.len() >= ENTRIES {
            return None;
        }
        let scan = self.scans.entry(key).or_insert_with(|| Scan {
            metadata: opened.clone(),
            offset: header_end,
            model: None,
            complete: false,
            generation: self.generation.wrapping_sub(1),
        });
        if scan.generation == self.generation {
            return scan.complete.then(|| scan.model.clone()).flatten();
        }
        scan.generation = self.generation;
        if scan.complete {
            return scan.model.clone();
        }
        file.seek(SeekFrom::Start(scan.offset)).ok()?;
        // Reserve a bounded scan slice once per linked session per collection.
        // BufReader reads at most this reservation, including read-ahead.
        let allowance = self.budget.min(MAX_MODEL_BYTES);
        self.budget -= allowance;
        let mut reader = BufReader::new(file.take(allowance));
        let mut line = Vec::new();
        let mut consumed = 0;
        while consumed < allowance {
            line.clear();
            let n = reader
                .by_ref()
                .take(MAX_LINE_BYTES + 1)
                .read_until(b'\n', &mut line)
                .ok()?;
            consumed += n as u64;
            if n as u64 > MAX_LINE_BYTES {
                // A pathological record cannot be used as model evidence.
                scan.model = None;
                return None;
            }
            if n == 0 {
                scan.complete = true;
                break;
            }
            if line.last() != Some(&b'\n') {
                // Retry an unfinished line on the next refresh. Budget exhaustion
                // is not EOF and must not publish an older model.
                scan.complete = scan.offset + n as u64 == opened.len();
                break;
            }
            scan.offset += n as u64;
            #[derive(Deserialize)]
            struct Kind<'a> {
                #[serde(rename = "type", borrow)]
                kind: &'a str,
            }
            if !serde_json::from_slice::<Kind<'_>>(&line).is_ok_and(|r| r.kind == "model_change") {
                continue;
            }
            scan.model = None;
            if let Ok(record) = serde_json::from_slice::<ModelRecord<'_>>(&line) {
                if record.kind == "model_change" {
                    scan.model = record
                        .provider
                        .zip(record.model_id)
                        .filter(|(p, m)| {
                            !p.is_empty()
                                && !m.is_empty()
                                && p.len() + m.len() < super::MAX_STRING
                                && !p.chars().any(char::is_control)
                                && !m.chars().any(char::is_control)
                        })
                        .map(|(p, m)| format!("{p}/{m}"));
                }
            }
        }
        self.budget += reader.get_ref().limit();
        scan.complete |= scan.offset == opened.len();
        let after = fs::symlink_metadata(&path).ok()?;
        if !after.is_file() || !same_file(&opened, &after) {
            scan.complete = false;
            return None;
        }
        scan.complete.then(|| scan.model.clone()).flatten()
    }

    pub(super) fn discover(&mut self, directory: &Path) -> Result<String, String> {
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
        self.read(&paths[0], &id)?;
        Ok(id)
    }

    fn read(&mut self, path: &Path, session: &str) -> Result<(), String> {
        let meta = fs::symlink_metadata(path).map_err(|_| "session log unavailable")?;
        if !meta.is_file() {
            return Err("session log is not a regular file".into());
        }
        let mut file = fs::File::open(path).map_err(|_| "session log unavailable")?;
        verify_header(&mut file, session)
    }
}

fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (a.dev(), a.ino(), a.ctime(), a.ctime_nsec())
            != (b.dev(), b.ino(), b.ctime(), b.ctime_nsec())
        {
            return false;
        }
    }
    a.len() == b.len() && a.modified().ok() == b.modified().ok()
}

fn verify_header(reader: &mut impl Read, session: &str) -> Result<(), String> {
    // Read exactly through the first newline: buffering or a prefix read could
    // pull conversation bytes into memory even if only the header were parsed.
    let mut bytes = Vec::new();
    for _ in 0..MAX_HEADER_BYTES {
        let mut byte = [0];
        reader
            .read_exact(&mut byte)
            .map_err(|_| "session header incomplete or unreadable")?;
        if byte[0] == b'\n' {
            let header: Header =
                serde_json::from_slice(&bytes).map_err(|_| "malformed session header")?;
            return if header.kind == "session" && header.version == 3 && header.id == session {
                Ok(())
            } else {
                Err("session header ID or format mismatch".into())
            };
        }
        bytes.push(byte[0]);
    }
    Err("session header byte limit exceeded".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn long_logs_resume_without_publishing_old_models_and_share_collection_budget() {
        let dir = std::env::temp_dir().join(format!("bdi-long-model-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut bytes = b"{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}\n{\"type\":\"model_change\",\"provider\":\"demo\",\"modelId\":\"old\"}\n".to_vec();
        let body = format!(
            "{{\"type\":\"message\",\"message\":\"{}\"}}\n",
            "invented ".repeat(100)
        );
        while bytes.len() <= MAX_MODEL_BYTES as usize + 4096 {
            bytes.extend_from_slice(body.as_bytes());
        }
        bytes.extend_from_slice(
            b"{\"type\":\"model_change\",\"provider\":\"demo\",\"modelId\":\"latest\"}\n",
        );
        let path = dir.join("invented_session-a.jsonl");
        fs::write(&path, &bytes).unwrap();
        let mut sessions = Sessions::default();
        sessions.begin_collection();
        assert_eq!(sessions.model(&dir, "session-a"), None);
        let offset = sessions.scans.values().next().unwrap().offset;
        assert!(offset > MAX_MODEL_BYTES - MAX_LINE_BYTES);
        let budget = sessions.budget;
        assert_eq!(sessions.model(&dir, "session-a"), None);
        assert_eq!(
            sessions.budget, budget,
            "shared coordinator is scanned only once"
        );
        assert_eq!(sessions.scans.values().next().unwrap().offset, offset);
        sessions.begin_collection();
        assert_eq!(
            sessions.model(&dir, "session-a").as_deref(),
            Some("demo/latest")
        );
        // Header validation remains mandatory even when a complete result is memoized.
        fs::write(
            &path,
            b"{\"type\":\"session\",\"version\":3,\"id\":\"other\"}\n",
        )
        .unwrap();
        assert_eq!(sessions.model(&dir, "session-a"), None);
        fs::write(&path, &bytes).unwrap();
        sessions.begin_collection();
        sessions.budget = 0;
        assert_eq!(sessions.model(&dir, "session-a"), None);
        assert!(sessions.scans.values().next().unwrap().offset < MAX_HEADER_BYTES as u64);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn model_switches_ignore_bodies_and_partial_appends_and_reverify_identity() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("bdi-model-only-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("invented_session-a.jsonl");
        let header = "{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}\n";
        fs::write(&path, format!("{header}{{\"type\":\"model_change\",\"provider\":\"demo\",\"modelId\":\"first\"}}\n")).unwrap();
        let mut sessions = Sessions::default();
        sessions.begin_collection();
        assert_eq!(
            sessions.model(&dir, "session-a").as_deref(),
            Some("demo/first")
        );
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{{\"type\":\"message\",\"provider\":{{\"private\":true}},\"message\":{{\"content\":[\"model_change demo/fake bead-1 working\"]}},\"modelId\":\"fake\"}}").unwrap();
        write!(
            file,
            "{{\"type\":\"model_change\",\"provider\":\"demo\",\"modelId\":\"second\""
        )
        .unwrap();
        assert_eq!(
            sessions.model(&dir, "session-a").as_deref(),
            Some("demo/first")
        );
        writeln!(file, "}}").unwrap();
        sessions.begin_collection();
        assert_eq!(
            sessions.model(&dir, "session-a").as_deref(),
            Some("demo/second")
        );
        // Truncation cannot keep the previous identity or model.
        fs::write(&path, header).unwrap();
        sessions.begin_collection();
        assert_eq!(sessions.model(&dir, "session-a"), None);
        fs::write(&path, "{\"type\":\"session\",\"version\":3,\"id\":\"other\"}\n{\"type\":\"model_change\",\"provider\":\"demo\",\"modelId\":\"wrong\"}\n").unwrap();
        sessions.begin_collection();
        assert_eq!(sessions.model(&dir, "session-a"), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn conversation_is_ignored_and_model_read_limits_fail_closed() {
        let record: ModelRecord<'_> = serde_json::from_str(r#"{"type":"model_change","provider":"demo","modelId":"first","message":{"content":[{"text":"invented secret"}]},"unknown":["invented secret"]}"#).unwrap();
        assert_eq!(record.provider, Some("demo"));
        let dir = std::env::temp_dir().join(format!("bdi-model-limit-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("invented_session-a.jsonl");
        let mut bytes = b"{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}\n{\"type\":\"model_change\",\"provider\":\"demo\",\"modelId\":\"first\"}\n".to_vec();
        bytes.extend(std::iter::repeat_n(b' ', MAX_LINE_BYTES as usize + 1));
        fs::write(&path, bytes).unwrap();
        let mut sessions = Sessions::default();
        sessions.begin_collection();
        assert_eq!(sessions.model(&dir, "session-a"), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn linked_and_discovered_identity_require_unique_matching_headers() {
        let dir = std::env::temp_dir().join(format!("bdi-header-only-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("invented_session-a.jsonl");
        let mut sessions = Sessions::default();
        sessions.begin_collection();
        assert!(sessions.verify(&dir, "../session-a").is_err());
        assert!(sessions.verify(&dir, "session-a").is_err());
        fs::write(
            &path,
            b"{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}\ninvalid body\xff",
        )
        .unwrap();
        sessions.verify(&dir, "session-a").unwrap();
        assert_eq!(sessions.discover(&dir).unwrap(), "session-a");
        fs::write(dir.join("other_session-a.jsonl"), b"unread").unwrap();
        assert!(sessions
            .verify(&dir, "session-a")
            .unwrap_err()
            .contains("ambiguous"));
        assert!(sessions.discover(&dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn verification_stops_at_header_without_reading_any_body_bytes() {
        let header = b"{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}\n";
        let mut bytes = header.to_vec();
        bytes.extend_from_slice(b"invalid JSON and invalid UTF-8: \xff\n");
        let mut reader = Cursor::new(bytes);
        verify_header(&mut reader, "session-a").unwrap();
        assert_eq!(reader.position(), header.len() as u64);
    }

    #[test]
    fn malformed_mismatched_unsupported_and_incomplete_headers_are_rejected() {
        for header in [
            "not json\n",
            "{\"type\":\"session\",\"version\":3,\"id\":\"other\"}\n",
            "{\"type\":\"session\",\"version\":4,\"id\":\"session-a\"}\n",
            "{\"type\":\"message\",\"version\":3,\"id\":\"session-a\"}\n",
            "{\"type\":\"session\",\"version\":3,\"id\":\"session-a\"}",
        ] {
            assert!(verify_header(&mut Cursor::new(header), "session-a").is_err());
        }
    }

    #[test]
    fn oversized_header_read_is_bounded() {
        let mut reader = Cursor::new(vec![b' '; MAX_HEADER_BYTES + 100]);
        assert!(verify_header(&mut reader, "session-a")
            .unwrap_err()
            .contains("limit"));
        assert_eq!(reader.position(), MAX_HEADER_BYTES as u64);
    }
}
