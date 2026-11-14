//! Read-only current-session resolution from an explicitly configured native registry.
use super::OmoConfig;
use crate::model::types::Pane;

/// A launch argument can outlive an in-process session switch. When a native
/// registry is configured, only its independently verified current identity wins.
pub fn resolve_runtime_session(pane: &mut Pane, config: &OmoConfig) -> Result<(), String> {
    if config.runtime_directory.is_none() || pane.app.as_deref() != Some("omo") {
        return Ok(());
    }
    if pane
        .agent_session
        .as_ref()
        .is_some_and(|s| s.source != "herdr:process-argv" && s.kind == "id")
    {
        return Ok(());
    }
    pane.agent_session = None;
    #[cfg(target_os = "linux")]
    {
        let id = linux::resolve(pane, config)?;
        pane.agent_session = Some(crate::model::types::AgentSession {
            agent: pane.agent.clone().ok_or("agent no longer present")?,
            kind: "id".into(),
            source: "omo:runtime-registry".into(),
            value: id,
        });
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    Err("native runtime registry process verification is unsupported on this platform".into())
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use chrono::{DateTime, Utc};
    use std::{
        collections::BTreeSet,
        fs,
        io::Read,
        os::unix::fs::{FileTypeExt, MetadataExt},
        path::Path,
    };

    fn small(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
        let meta = fs::symlink_metadata(path).map_err(|_| "native evidence unavailable")?;
        if !meta.is_file() || meta.len() > limit {
            return Err("native evidence is not a bounded regular file".into());
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|_| "native evidence unavailable")?
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "native evidence unreadable")?;
        if bytes.len() as u64 > limit {
            return Err("native evidence read limit exceeded".into());
        }
        Ok(bytes)
    }
    fn proc_text(path: &Path) -> Result<String, String> {
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|_| "process evidence unavailable")?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "process evidence unreadable")?;
        if bytes.len() > 1024 * 1024 {
            return Err("process evidence read limit exceeded".into());
        }
        String::from_utf8(bytes).map_err(|_| "process evidence unsupported".into())
    }
    fn born(pid: u32) -> Result<i64, String> {
        let stat = proc_text(Path::new(&format!("/proc/{pid}/stat")))?;
        let ticks = stat
            .rsplit_once(')')
            .and_then(|(_, s)| s.split_whitespace().nth(19))
            .and_then(|v| v.parse::<i64>().ok())
            .ok_or("process start time unavailable")?;
        let boot = proc_text(Path::new("/proc/stat"))?
            .lines()
            .find_map(|l| l.strip_prefix("btime ").and_then(|v| v.parse::<i64>().ok()))
            .ok_or("boot time unavailable")?;
        // Linux reports process start time in the host's clock ticks.
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if hz <= 0 {
            return Err("clock tick rate unavailable".into());
        }
        Ok(boot * 1000 + ticks * 1000 / hz)
    }
    pub(super) fn resolve(pane: &Pane, config: &OmoConfig) -> Result<String, String> {
        let directory = config
            .runtime_directory
            .as_ref()
            .ok_or("runtime directory not configured")?;
        let sessions = config
            .session_directory
            .as_ref()
            .ok_or("session directory required for runtime verification")?;
        let store = config
            .task_directory
            .parent()
            .ok_or("native task store unavailable")?;
        let pid = pane.process_id.ok_or("foreground process ID unavailable")?;
        let started = born(pid)?;
        let bound: BTreeSet<String> = proc_text(Path::new("/proc/net/unix"))?
            .lines()
            .skip(1)
            .filter_map(|l| l.split_whitespace().nth(7).map(str::to_owned))
            .collect();
        let entries = fs::read_dir(directory).map_err(|_| "runtime registry unavailable")?;
        let mut budget = 512 * 1024usize;
        let mut owners = BTreeSet::new();
        for (at, entry) in entries.take(513).enumerate() {
            if at == 512 {
                return Err("runtime registry entry limit exceeded".into());
            }
            let entry = entry.map_err(|_| "runtime registry unreadable")?;
            let name = entry.file_name();
            let Some(stem) = name.to_str().and_then(|s| s.strip_suffix(".meta.json")) else {
                continue;
            };
            let bytes = match small(&entry.path(), 16 * 1024) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            if bytes.len() > budget {
                return Err("runtime registry read budget exceeded".into());
            }
            budget -= bytes.len();
            let Ok(meta) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                continue;
            };
            if meta.get("kind").and_then(|v| v.as_str()) != Some("p")
                || meta.get("created_by_pid").and_then(|v| v.as_u64()) != Some(pid.into())
            {
                continue;
            }
            let Some(created) = meta
                .get("created_at")
                .and_then(|v| v.as_str())
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            else {
                continue;
            };
            if created.timestamp_millis() < started - 1000
                || created.timestamp_millis() > Utc::now().timestamp_millis() + 1000
            {
                continue;
            }
            if !meta
                .get("stores")
                .and_then(|v| v.as_array())
                .is_some_and(|stores| {
                    stores
                        .iter()
                        .any(|s| s.as_str().is_some_and(|s| Path::new(s) == store))
                })
            {
                continue;
            }
            let socket = directory.join(format!("{stem}.sock"));
            let root = fs::canonicalize(directory).ok();
            let socket_meta = fs::metadata(&socket)
                .ok()
                .filter(|m| m.file_type().is_socket());
            let bound_matching =
                socket_meta
                    .as_ref()
                    .zip(root.as_ref())
                    .is_some_and(|(wanted, root)| {
                        bound.iter().any(|candidate| {
                            let path = Path::new(candidate);
                            let direct = path == root.join(format!("{stem}.sock"));
                            let native_link = path.file_name().is_some_and(|n| n == "s")
                                && path.parent().is_some_and(|parent| {
                                    parent.parent() == Some(root.as_path())
                                        && parent.file_name().and_then(|n| n.to_str()).is_some_and(
                                            |name| name.starts_with(&format!("{stem}.sock.bind-")),
                                        )
                                });
                            (direct || native_link)
                                && fs::metadata(path).is_ok_and(|m| {
                                    m.file_type().is_socket()
                                        && m.dev() == wanted.dev()
                                        && m.ino() == wanted.ino()
                                })
                        })
                    });
            if meta.get("socket").and_then(|v| v.as_str()).map(Path::new) != Some(socket.as_path())
                || !bound_matching
            {
                continue;
            }
            let Some(id) = meta
                .get("owner_session_id")
                .and_then(|v| v.as_str())
                .filter(|id| super::super::safe_id(id))
            else {
                continue;
            };
            let Some(file) = meta
                .get("owner_session_file")
                .and_then(|v| v.as_str())
                .map(Path::new)
            else {
                continue;
            };
            if file.parent() != Some(sessions.as_path())
                || !file
                    .file_name()
                    .and_then(|v| v.to_str())
                    .is_some_and(|name| name.ends_with(&format!("_{id}.jsonl")))
            {
                continue;
            }
            if !fs::symlink_metadata(file).is_ok_and(|m| m.is_file()) {
                continue;
            }
            let mut bytes = Vec::new();
            let Ok(file) = fs::File::open(file) else {
                continue;
            };
            if file.take(8193).read_to_end(&mut bytes).is_err() {
                continue;
            }
            let Some(end) = bytes.iter().position(|b| *b == b'\n') else {
                continue;
            };
            let header = &bytes[..end];
            let Ok(header) = serde_json::from_slice::<serde_json::Value>(header) else {
                continue;
            };
            if header.get("type").and_then(|v| v.as_str()) != Some("session")
                || header.get("version").and_then(|v| v.as_u64()) != Some(3)
                || header.get("id").and_then(|v| v.as_str()) != Some(id)
                || header.get("cwd").and_then(|v| v.as_str()).map(Path::new)
                    != Some(pane.cwd.as_path())
            {
                continue;
            }
            owners.insert(id.to_owned());
        }
        if owners.len() != 1 {
            return Err("current runtime session missing or ambiguous".into());
        }
        if born(pid)? != started {
            return Err("process changed during native identity lookup".into());
        }
        Ok(owners.into_iter().next().unwrap())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::model::types::{AgentSession, PaneStatus};
    use std::{
        fs,
        os::unix::net::UnixListener,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Ground(PathBuf);
    impl Drop for Ground {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn setup() -> (Ground, OmoConfig, Pane) {
        let root = Ground(std::env::temp_dir().join(format!(
            "bdi-rp-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )));
        let cfg = OmoConfig {
            task_directory: root.0.join("native/tasks"),
            session_directory: Some(root.0.join("sessions/project")),
            runtime_directory: Some(root.0.join("rpc/shards")),
            ..OmoConfig::default()
        };
        fs::create_dir_all(cfg.session_directory.as_ref().unwrap()).unwrap();
        fs::create_dir_all(cfg.runtime_directory.as_ref().unwrap()).unwrap();
        let mut pane = Pane::answered(
            "default".into(),
            "w:p1".into(),
            "/srv/arkham".into(),
            PaneStatus::Working,
        );
        pane.app = Some("omo".into());
        pane.agent = Some("pi".into());
        pane.process_id = Some(std::process::id());
        pane.agent_session = Some(AgentSession {
            agent: "pi".into(),
            kind: "id".into(),
            source: "herdr:process-argv".into(),
            value: "launch-owner".into(),
        });
        (root, cfg, pane)
    }
    fn entry(config: &OmoConfig, id: &str) -> (UnixListener, PathBuf) {
        let socket = config
            .runtime_directory
            .as_ref()
            .unwrap()
            .join(format!("{id}.sock"));
        let listener = UnixListener::bind(&socket).unwrap();
        let session = config
            .session_directory
            .as_ref()
            .unwrap()
            .join(format!("invented_{id}.jsonl"));
        fs::write(
            &session,
            format!(
                "{}\n",
                serde_json::json!({"type":"session","version":3,"id":id,"cwd":"/srv/arkham"})
            ),
        )
        .unwrap();
        let path = config
            .runtime_directory
            .as_ref()
            .unwrap()
            .join(format!("{id}.meta.json"));
        fs::write(&path,serde_json::json!({"socket":socket,"kind":"p","created_by_pid":std::process::id(),"created_at":chrono::Utc::now().to_rfc3339(),"stores":[config.task_directory.parent().unwrap()],"owner_session_id":id,"owner_session_file":session}).to_string()).unwrap();
        (listener, path)
    }
    #[test]
    fn switched_runtime_identity_replaces_launch_id_and_ignores_unbound_old_registry() {
        let (_ground, cfg, mut pane) = setup();
        let (_current, _) = entry(&cfg, "current-owner");
        let (old, _) = entry(&cfg, "launch-owner");
        drop(old);
        resolve_runtime_session(&mut pane, &cfg).unwrap();
        assert_eq!(pane.live_agent_session(), Some("current-owner"));
        assert_eq!(
            pane.agent_session.as_ref().unwrap().source,
            "omo:runtime-registry"
        );
    }
    #[test]
    fn malformed_old_wrong_store_header_or_ambiguous_metadata_cannot_award_a_session() {
        for case in [
            "pid",
            "store",
            "header",
            "created",
            "malformed",
            "ambiguous",
            "missing-pid",
        ] {
            let (_ground, cfg, mut pane) = setup();
            let (_listener, path) = entry(&cfg, "current-owner");
            let mut meta: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            let mut extra = None;
            match case {
                "pid" => meta["created_by_pid"] = 0.into(),
                "store" => meta["stores"] = serde_json::json!(["/srv/dunwich"]),
                "header" => fs::write(
                    cfg.session_directory
                        .as_ref()
                        .unwrap()
                        .join("invented_current-owner.jsonl"),
                    "{\"type\":\"session\",\"version\":3,\"id\":\"different-owner\"}\n",
                )
                .unwrap(),
                "created" => meta["created_at"] = "2000-01-01T00:00:00Z".into(),
                "malformed" => meta = serde_json::Value::Null,
                "ambiguous" => extra = Some(entry(&cfg, "other-owner").0),
                "missing-pid" => pane.process_id = None,
                _ => unreachable!(),
            }
            fs::write(path, meta.to_string()).unwrap();
            assert!(resolve_runtime_session(&mut pane, &cfg).is_err(), "{case}");
            assert!(
                pane.agent_session.is_none(),
                "no stale launch fallback: {case}"
            );
            drop(extra);
        }
    }
    #[test]
    fn a_registry_socket_symlink_to_a_bound_socket_inside_the_registry_is_valid() {
        use std::os::unix::fs::symlink;
        let (_ground, cfg, mut pane) = setup();
        let (old, path) = entry(&cfg, "current-owner");
        drop(old);
        let socket = cfg
            .runtime_directory
            .as_ref()
            .unwrap()
            .join("current-owner.sock");
        fs::remove_file(&socket).unwrap();
        let dir = cfg
            .runtime_directory
            .as_ref()
            .unwrap()
            .join("current-owner.sock.bind-invented");
        fs::create_dir(&dir).unwrap();
        let _listener = UnixListener::bind(dir.join("s")).unwrap();
        symlink(dir.join("s"), &socket).unwrap();
        assert!(path.exists());
        resolve_runtime_session(&mut pane, &cfg).unwrap();
        assert_eq!(pane.live_agent_session(), Some("current-owner"));
    }

    #[test]
    fn native_socket_hard_link_is_matched_to_its_bound_inode() {
        let (_ground, cfg, mut pane) = setup();
        let (old, _) = entry(&cfg, "current-owner");
        drop(old);
        let socket = cfg
            .runtime_directory
            .as_ref()
            .unwrap()
            .join("current-owner.sock");
        fs::remove_file(&socket).unwrap();
        let dir = cfg
            .runtime_directory
            .as_ref()
            .unwrap()
            .join("current-owner.sock.bind-invented");
        fs::create_dir(&dir).unwrap();
        let _listener = UnixListener::bind(dir.join("s")).unwrap();
        fs::hard_link(dir.join("s"), &socket).unwrap();
        resolve_runtime_session(&mut pane, &cfg).unwrap();
        assert_eq!(pane.live_agent_session(), Some("current-owner"));
    }

    #[test]
    fn canonical_reported_identity_is_not_overridden_by_a_fallback_registry() {
        let (_ground, cfg, mut pane) = setup();
        pane.agent_session.as_mut().unwrap().source = "herdr:native".into();
        resolve_runtime_session(&mut pane, &cfg).unwrap();
        assert_eq!(pane.live_agent_session(), Some("launch-owner"));
    }
}
