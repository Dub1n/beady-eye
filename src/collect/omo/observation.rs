//! Optional bounded metadata snapshots from the standalone OmO observer package.
//! Admissions establish associations. Expiring baselines establish presence and
//! execution independently. Beads rows and native files remain authoritative.
use super::*;
use std::collections::BTreeSet;
mod admission;
use admission::Admission;

const MAX_FRAMES: usize = 64;
const MAX_ADMISSION_CACHES: usize = 64;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ADMISSION_CACHE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceState {
    LiveIdle,
    LiveBusy,
    Unknown,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    project: String,
    task_directory: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Frame {
    version: u32,
    scope: Scope,
    epoch: String,
    sequence: u64,
    observed_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    admissions: Vec<Admission>,
    workers: Vec<Worker>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Worker {
    session: String,
    identity: String,
    model: Option<String>,
    presence: PresenceState,
    execution: ExecutionState,
    source: String,
    observed_at: DateTime<Utc>,
    task: Option<String>,
    parent: Option<String>,
    created: Option<String>,
    child: Option<String>,
    run_epoch: Option<u64>,
    pid: Option<u32>,
    start_ticks: Option<String>,
    pid_namespace: Option<String>,
}
#[derive(Default)]
pub(super) struct Observations {
    frames: Vec<Frame>,
    admissions: BTreeMap<(String, String), Vec<Admission>>,
    sequences: BTreeMap<String, (u64, DateTime<Utc>)>,
    pub reason: Option<&'static str>,
}
#[derive(Debug)]
pub(super) enum QualificationError {
    MissingAdmission,
    MissingGeneration,
    InvalidAdmission,
    CoordinatorMismatch,
}
impl QualificationError {
    pub fn is_conflict(&self) -> bool {
        !matches!(self, Self::MissingAdmission | Self::MissingGeneration)
    }
    pub fn reason(&self) -> &'static str {
        match self {
            Self::MissingAdmission => "future guarded admission not observed",
            Self::MissingGeneration => "durable admission lacks the current task generation",
            Self::InvalidAdmission => "guarded admission conflicts with current task or receipt",
            Self::CoordinatorMismatch => "attempt coordinator does not match native parent",
        }
    }
}
pub(super) struct Qualified {
    pub session: Option<String>,
    pub baseline: Option<Baseline>,
}
pub(super) struct Baseline {
    pub identity: String,
    pub model: Option<String>,
    pub presence: PresenceState,
    pub execution: ExecutionState,
    pub observed_at: DateTime<Utc>,
    pub source: String,
}
impl Observations {
    pub fn refresh(&mut self, config: &OmoConfig) {
        self.frames.clear();
        self.admissions.clear();
        self.reason = None;
        if config.observation_directory.is_none() {
            return;
        }
        if self.load(config).is_err() {
            self.frames.clear();
            self.admissions.clear();
            self.reason =
                Some("observer directory unavailable, unsafe, malformed or over capacity");
        }
    }
    fn load(&mut self, config: &OmoConfig) -> Result<(), ()> {
        let directory = config.observation_directory.as_deref().ok_or(())?;
        let mut sequences = self.sequences.clone();
        let mut frame_bytes = 0u64;
        let mut admission_bytes = 0u64;
        let mut admission_caches = 0;
        let mut admissions = BTreeMap::new();
        let mut names = BTreeSet::new();
        for entry in fs::read_dir(directory).map_err(|_| ())? {
            let entry = entry.map_err(|_| ())?;
            let name = entry.file_name();
            let name = name.to_str().ok_or(())?;
            let path = entry.path();
            if name.starts_with("frame-") && name.ends_with(".json") {
                if names.len() == MAX_FRAMES || !entry.file_type().map_err(|_| ())?.is_file() {
                    return Err(());
                }
                names.insert(name.to_owned());
                let Some((bytes, _)) = read_bounded(&path, MAX_RECORD_BYTES).map_err(|_| ())?
                else {
                    continue;
                };
                frame_bytes = frame_bytes
                    .checked_add(u64::try_from(bytes.len()).map_err(|_| ())?)
                    .ok_or(())?;
                if frame_bytes > MAX_TOTAL_BYTES {
                    return Err(());
                }
                let frame: Frame = serde_json::from_slice(&bytes).map_err(|_| ())?;
                if frame.version != 1
                    || !safe_id(&frame.epoch)
                    || frame.admissions.len() > 128
                    || frame.workers.len() > 128
                    || frame
                        .expires_at
                        .signed_duration_since(frame.observed_at)
                        .num_milliseconds()
                        > 5000
                    || frame.expires_at < frame.observed_at
                {
                    return Err(());
                }
                if let Some((seq, at)) = self.sequences.get(name) {
                    if frame.sequence < *seq || frame.observed_at < *at {
                        continue;
                    }
                }
                sequences.insert(name.to_owned(), (frame.sequence, frame.observed_at));
                self.frames.push(frame);
            } else if name.starts_with("admission-") && name.ends_with(".json") {
                admission_caches += 1;
                if admission_caches > MAX_ADMISSION_CACHES {
                    self.reason = Some("observer admission caches exceed capacity");
                    continue;
                }
                if !entry.file_type().map_err(|_| ())?.is_file() {
                    self.reason = Some("observer admission cache is not a regular file");
                    continue;
                }
                let cache = match admission::read_cache(&path) {
                    Ok(Some(cache)) => cache,
                    Ok(None) => continue,
                    Err(()) => {
                        self.reason = Some("observer admission cache is malformed or unavailable");
                        continue;
                    }
                };
                let Some(next_admission_bytes) = admission_bytes.checked_add(cache.bytes) else {
                    self.reason = Some("observer admission caches exceed byte capacity");
                    continue;
                };
                if next_admission_bytes > MAX_ADMISSION_CACHE_BYTES {
                    self.reason = Some("observer admission caches exceed byte capacity");
                    continue;
                }
                admission_bytes = next_admission_bytes;
                if cache.scope.task_directory == config.task_directory {
                    let key = (cache.scope.project, cache.parent);
                    if admissions.insert(key.clone(), cache.admissions).is_some() {
                        admissions.remove(&key);
                        self.reason = Some("observer admission cache parent is ambiguous");
                    }
                }
            }
        }
        sequences.retain(|name, _| names.contains(name));
        self.sequences = sequences;
        self.admissions = admissions;
        Ok(())
    }
    /// Current-attempt ownership identifies a coordinator independently of a
    /// delegated execution admission. Its busy state never activates owned work.
    pub fn coordinator(
        &self,
        config: &OmoConfig,
        project: &str,
        session: &str,
        now: DateTime<Utc>,
    ) -> Option<Baseline> {
        let mut matches = self
            .frames
            .iter()
            .filter(|f| {
                f.scope.project == project
                    && f.scope.task_directory == config.task_directory
                    && f.expires_at > now
                    && f.observed_at <= now + chrono::Duration::seconds(1)
            })
            .flat_map(|f| &f.workers)
            .filter(|w| {
                w.source == "public-context"
                    && w.session == session
                    && !w.identity.is_empty()
                    && w.identity.len() <= 512
                    && w.model.as_ref().is_none_or(|m| m.len() <= 512)
                    && w.observed_at <= now + chrono::Duration::seconds(1)
                    && now.signed_duration_since(w.observed_at).num_milliseconds() <= 3000
                    && process_matches(w)
            });
        let w = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        Some(Baseline {
            identity: w.identity.clone(),
            model: w.model.clone(),
            presence: w.presence,
            execution: ExecutionState::Unknown,
            observed_at: w.observed_at,
            source: w.source.clone(),
        })
    }

    pub fn qualify(
        &self,
        config: &OmoConfig,
        input: &BeadInput,
        receipt: &Value,
        native: &Value,
        now: DateTime<Utc>,
    ) -> Result<Qualified, QualificationError> {
        let attempt = path_value(&input.fields, &config.attempt_path)
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str);
        let Some(parent) = text(native, "parent_session_id") else {
            return Err(QualificationError::CoordinatorMismatch);
        };
        if path_value(&input.fields, &config.attempt_path)
            .and_then(|v| v.get("coordinator"))
            .and_then(Value::as_str)
            != Some(parent.as_str())
        {
            return Err(QualificationError::CoordinatorMismatch);
        }
        let created = text(native, "created_at");
        let task = text(native, "task_id");
        let frame_admissions: Vec<_> = self
            .frames
            .iter()
            .filter(|f| {
                f.scope.project == input.project
                    && f.scope.task_directory == config.task_directory
                    && f.expires_at > now
                    && f.observed_at <= now + chrono::Duration::seconds(1)
            })
            .flat_map(|f| &f.admissions)
            .filter(|a| {
                a.bead == input.bead_id
                    && Some(a.attempt.as_str()) == attempt
                    && Some(a.task.as_str()) == receipt.get("taskId").and_then(Value::as_str)
                    && Some(a.tool_call.as_str())
                        == receipt.get("toolCallId").and_then(Value::as_str)
            })
            .cloned()
            .collect();
        let expired_frame_admissions: Vec<_> = self
            .frames
            .iter()
            .filter(|f| {
                f.scope.project == input.project
                    && f.scope.task_directory == config.task_directory
                    && f.expires_at <= now
                    && f.observed_at <= now + chrono::Duration::seconds(1)
            })
            .flat_map(|f| &f.admissions)
            .filter(|a| {
                a.bead == input.bead_id
                    && Some(a.attempt.as_str()) == attempt
                    && Some(a.task.as_str()) == receipt.get("taskId").and_then(Value::as_str)
                    && Some(a.tool_call.as_str())
                        == receipt.get("toolCallId").and_then(Value::as_str)
            })
            .cloned()
            .collect();
        let durable_admissions: Vec<_> = self
            .admissions
            .get(&(input.project.clone(), parent.clone()))
            .into_iter()
            .flatten()
            .filter(|a| {
                a.bead == input.bead_id
                    && Some(a.attempt.as_str()) == attempt
                    && Some(a.task.as_str()) == receipt.get("taskId").and_then(Value::as_str)
                    && Some(a.tool_call.as_str())
                        == receipt.get("toolCallId").and_then(Value::as_str)
            })
            .cloned()
            .collect();
        if frame_admissions.iter().any(|frame| {
            durable_admissions
                .iter()
                .any(|durable| durable.invalid || !frame.same_dispatch(durable))
        }) || expired_frame_admissions.iter().any(|expired| {
            expired.invalid
                || durable_admissions
                    .iter()
                    .any(|durable| !expired.same_dispatch(durable))
        }) {
            return Err(QualificationError::InvalidAdmission);
        }
        let mut durable_only = false;
        let mut admissions = frame_admissions;
        if admissions.is_empty() && !durable_admissions.is_empty() {
            durable_only = true;
            admissions.extend(durable_admissions);
        } else if admissions.is_empty() && self.reason.is_none() {
            durable_only = true;
            admissions.extend(expired_frame_admissions);
        }
        let Some(a) = admissions.first() else {
            return Err(QualificationError::MissingAdmission);
        };
        if admissions.iter().any(|other| other != a)
            || a.invalid
            || a.parent != parent
            || Some(a.created.as_str()) != created.as_deref()
            || Some(a.task.as_str()) != task.as_deref()
            || receipt.get("outcome").and_then(Value::as_str) != Some("native-admitted")
            || !safe_id(&a.parent)
            || a.created.is_empty()
            || receipt
                .get("childSession")
                .and_then(Value::as_str)
                .is_some_and(|s| Some(s) != a.initial_child.as_deref())
        {
            return Err(QualificationError::InvalidAdmission);
        }
        let current = text(native, "child_session_id");
        let pid = native
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|p| u32::try_from(p).ok());
        let mut candidates = Vec::new();
        let native_epoch = native
            .get("notification")
            .and_then(|n| n.get("run_epoch"))
            .and_then(Value::as_u64);
        for f in &self.frames {
            if f.scope.project != input.project
                || f.scope.task_directory != config.task_directory
                || f.expires_at <= now
                || f.observed_at > now + chrono::Duration::seconds(1)
            {
                continue;
            }
            for w in &f.workers {
                if w.observed_at > now + chrono::Duration::seconds(1)
                    || now.signed_duration_since(w.observed_at).num_milliseconds() > 3000
                    || !safe_id(&w.session)
                    || w.identity.is_empty()
                    || w.identity.len() > 512
                    || w.source.len() > 128
                    || w.model.as_ref().is_some_and(|s| s.len() > 512)
                {
                    continue;
                }
                let matched = if let Some(child) = &current {
                    &w.session == child
                        && w.child.as_ref() == Some(child)
                        && w.task.as_deref() == task.as_deref()
                        && w.parent.as_deref() == Some(parent.as_str())
                        && w.created.as_deref() == created.as_deref()
                        && w.run_epoch
                            == native
                                .get("notification")
                                .and_then(|n| n.get("run_epoch"))
                                .and_then(Value::as_u64)
                } else {
                    w.source == "public-context"
                        && pid.is_some()
                        && w.pid == pid
                        && w.start_ticks.is_some()
                        && w.pid_namespace.is_some()
                        && process_matches(w)
                };
                if matched {
                    candidates.push(w);
                }
            }
        }
        let generation_matches = a.run_epoch == native_epoch;
        if durable_only && (a.run_epoch.is_none() || native_epoch.is_none()) {
            return Err(QualificationError::MissingGeneration);
        }
        if (durable_only || candidates.len() != 1) && !generation_matches {
            if a.run_epoch.is_none() || native_epoch.is_none() {
                return Err(QualificationError::MissingGeneration);
            }
            return Err(QualificationError::InvalidAdmission);
        }
        // A current assignment survives unavailable activity; never choose among
        // independent live instances, even if they report the same model.
        if candidates.len() > 1 {
            return Ok(Qualified {
                session: current,
                baseline: None,
            });
        }
        let baseline = candidates.first().map(|w| Baseline {
            identity: w.identity.clone(),
            model: w.model.clone(),
            presence: w.presence,
            execution: w.execution,
            observed_at: w.observed_at,
            source: w.source.clone(),
        });
        let session = current.or_else(|| candidates.first().map(|w| w.session.clone()));
        Ok(Qualified { session, baseline })
    }
}
#[cfg(target_os = "linux")]
fn process_matches(w: &Worker) -> bool {
    let Some(pid) = w.pid.filter(|p| *p > 0) else {
        return false;
    };
    let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    let ticks = stat
        .rsplit_once(") ")
        .and_then(|(_, s)| s.split_whitespace().nth(19));
    let namespace = fs::read_link(format!("/proc/{pid}/ns/pid")).ok();
    ticks == w.start_ticks.as_deref()
        && namespace.as_ref().and_then(|p| p.to_str()) == w.pid_namespace.as_deref()
}
#[cfg(not(target_os = "linux"))]
fn process_matches(_: &Worker) -> bool {
    false
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    pub(super) struct Ground {
        dir: PathBuf,
        pub(super) config: OmoConfig,
        pub(super) input: BeadInput,
        pub(super) frame: Value,
        pub(super) native: Value,
    }
    impl Drop for Ground {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    impl Ground {
        pub(super) fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "bdi-observation-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(dir.join("tasks")).unwrap();
            fs::create_dir_all(dir.join("observations")).unwrap();
            let config = OmoConfig {
                task_directory: dir.join("tasks"),
                observation_directory: Some(dir.join("observations")),
                ..Default::default()
            };
            let now = Utc::now();
            let native = json!({"task_id":"st_orchard","parent_session_id":"parent-a","created_at":"2026-01-01T00:00:00Z","updated_at":now,"status":"running","child_session_id":"child-new","notification":{"run_epoch":7}});
            let frame = json!({"version":1,"scope":{"project":"orchard","taskDirectory":config.task_directory},"epoch":"epoch-a","sequence":1,"observedAt":now,"expiresAt":now+chrono::Duration::seconds(3),
                "admissions":[{"bead":"fruit-1","attempt":"attempt-a","toolCall":"call-a","task":"st_orchard","parent":"parent-a","created":"2026-01-01T00:00:00Z","initialChild":"child-old","runEpoch":7,"invalid":false}],
                "workers":[{"session":"child-new","identity":"host:instance-a:child-new:activity-a","model":"invented/gpt-6-luna","presence":"live_idle","execution":"inactive","source":"authenticated-host-baseline","observedAt":now,"task":"st_orchard","parent":"parent-a","created":"2026-01-01T00:00:00Z","child":"child-new","runEpoch":7}]});
            let input = BeadInput {
                project: "orchard".into(),
                bead_id: "fruit-1".into(),
                bead_status: Some("in_progress".into()),
                fields: json!({"metadata":{"qrclipWork":{"attempt":{"id":"attempt-a","coordinator":"parent-a"}},"qrclipDispatch":{"attemptId":"attempt-a","taskId":"st_orchard","toolCallId":"call-a","outcome":"native-admitted"}}}),
            };
            Self {
                dir,
                config,
                input,
                frame,
                native,
            }
        }
        pub(super) fn write(&self) {
            fs::write(
                self.config.task_directory.join("st_orchard.json"),
                self.native.to_string(),
            )
            .unwrap();
            fs::write(
                self.config
                    .observation_directory
                    .as_ref()
                    .unwrap()
                    .join("frame-test.json"),
                self.frame.to_string(),
            )
            .unwrap();
        }
        pub(super) fn read(&self) -> Activity {
            self.write();
            Reader::new(self.config.clone())
                .collect(std::slice::from_ref(&self.input))
                .activities
                .remove(&("orchard".into(), "fruit-1".into()))
                .unwrap()
        }
    }
    #[test]
    fn childless_receipt_tracks_current_replacement_and_idle_presence_separately() {
        let g = Ground::new();
        let a = g.read();
        assert_eq!(a.child_session.as_deref(), Some("child-new"));
        assert_eq!(a.presence_state(), PresenceState::LiveIdle);
        assert_eq!(a.execution_state(), ExecutionState::Inactive);
        assert_ne!(a.state, ActivityState::Finished);
        assert!(!a.acceptance_ready);
        assert_eq!(a.model_label(), Some("Luna"));
        assert!(a.worker_identity.is_some());
    }
    #[test]
    fn baseline_is_active_only_for_running_current_task_and_never_acceptance() {
        for status in ["running", "completed", "error", "pending", "interrupted"] {
            let mut g = Ground::new();
            g.frame["workers"][0]["execution"] = json!("active");
            g.frame["workers"][0]["presence"] = json!("live_busy");
            g.native["status"] = json!(status);
            let a = g.read();
            assert_eq!(
                a.execution_state(),
                match status {
                    "running" => ExecutionState::Active,
                    "pending" => ExecutionState::Unknown,
                    _ => ExecutionState::Inactive,
                },
                "{status}"
            );
            assert_eq!(a.presence_state(), PresenceState::LiveBusy);
            assert!(!a.acceptance_ready);
        }
    }
    #[test]
    fn unknown_activity_retains_assignment_but_no_live_claim() {
        for case in [
            "expired",
            "old-child",
            "old-task",
            "old-parent",
            "old-creation",
            "ambiguous",
            "future-baseline",
        ] {
            let mut g = Ground::new();
            match case {
                "expired" => {
                    g.frame["observedAt"] = json!(Utc::now() - chrono::Duration::seconds(6));
                    g.frame["expiresAt"] = json!(Utc::now() - chrono::Duration::seconds(3));
                }
                "old-child" => g.frame["workers"][0]["child"] = json!("child-old"),
                "old-task" => g.frame["workers"][0]["task"] = json!("st_old"),
                "old-parent" => g.frame["workers"][0]["parent"] = json!("parent-old"),
                "old-creation" => g.frame["workers"][0]["created"] = json!("2025-01-01T00:00:00Z"),
                "ambiguous" => {
                    let old = g.frame["workers"][0].clone();
                    g.frame["workers"].as_array_mut().unwrap().push(old);
                }
                "future-baseline" => {
                    g.frame["workers"][0]["observedAt"] =
                        json!(Utc::now() + chrono::Duration::seconds(30))
                }
                _ => unreachable!(),
            }
            let a = g.read();
            assert_eq!(a.child_session.as_deref(), Some("child-new"), "{case}");
            assert_eq!(a.execution_state(), ExecutionState::Unknown, "{case}");
            assert_eq!(a.presence_state(), PresenceState::Unknown, "{case}");
        }
    }
    #[test]
    fn scope_attempt_tool_call_creation_and_observed_removal_fence_admissions() {
        for case in [
            "project",
            "store",
            "attempt",
            "call",
            "created",
            "removed",
            "parent",
            "receipt-outcome",
        ] {
            let mut g = Ground::new();
            match case {
                "project" => g.frame["scope"]["project"] = json!("elsewhere"),
                "store" => g.frame["scope"]["taskDirectory"] = json!("/srv/other/tasks"),
                "attempt" => {
                    g.input.fields["metadata"]["qrclipWork"]["attempt"]["id"] = json!("attempt-b")
                }
                "call" => g.frame["admissions"][0]["toolCall"] = json!("call-old"),
                "created" => g.native["created_at"] = json!("2026-02-01T00:00:00Z"),
                "removed" => g.frame["admissions"][0]["invalid"] = json!(true),
                "parent" => g.frame["admissions"][0]["parent"] = json!("parent-other"),
                "receipt-outcome" => {
                    g.input.fields["metadata"]["qrclipDispatch"]["outcome"] = json!("native-error")
                }
                _ => unreachable!(),
            }
            let a = g.read();
            assert_eq!(a.child_session, None, "{case}");
            assert_eq!(a.execution_state(), ExecutionState::Unknown, "{case}");
            assert_eq!(a.effective_model, None, "{case}");
        }
    }
    #[test]
    fn receipt_original_child_does_not_pin_current_child() {
        let mut g = Ground::new();
        g.input.fields["metadata"]["qrclipDispatch"]["childSession"] = json!("child-old");
        assert_eq!(g.read().child_session.as_deref(), Some("child-new"));
        g.input.fields["metadata"]["qrclipDispatch"]["childSession"] = json!("different-original");
        assert_eq!(g.read().state, ActivityState::Conflict);
    }
    #[test]
    fn rollback_partial_json_and_overflow_do_not_restore_old_execution() {
        let mut g = Ground::new();
        g.write();
        let mut observations = Observations::default();
        observations.refresh(&g.config);
        assert_eq!(observations.frames.len(), 1);
        g.frame["sequence"] = json!(0);
        g.write();
        observations.refresh(&g.config);
        assert!(observations.frames.is_empty());
        fs::write(
            g.config
                .observation_directory
                .as_ref()
                .unwrap()
                .join("frame-test.json"),
            "{",
        )
        .unwrap();
        observations.refresh(&g.config);
        assert!(observations.frames.is_empty());
        assert!(observations.reason.is_some());
        g.frame["workers"] = Value::Array(vec![g.frame["workers"][0].clone(); 129]);
        g.write();
        observations.refresh(&g.config);
        assert!(observations.frames.is_empty());
        assert!(observations.reason.is_some());
    }
    #[test]
    fn process_identity_cannot_be_guessed_from_numeric_pid() {
        let mut g = Ground::new();
        g.native.as_object_mut().unwrap().remove("child_session_id");
        g.native["pid"] = json!(std::process::id());
        let w = &mut g.frame["workers"][0];
        w["source"] = json!("public-context");
        w["task"] = Value::Null;
        w["pid"] = json!(std::process::id());
        w["startTicks"] = json!("incorrect");
        w["pidNamespace"] = json!("incorrect");
        assert_eq!(g.read().child_session, None);
        #[cfg(target_os = "linux")]
        {
            let stat = fs::read_to_string("/proc/self/stat").unwrap();
            let ticks = stat
                .rsplit_once(") ")
                .unwrap()
                .1
                .split_whitespace()
                .nth(19)
                .unwrap();
            g.frame["workers"][0]["startTicks"] = json!(ticks);
            g.frame["workers"][0]["pidNamespace"] = json!(fs::read_link("/proc/self/ns/pid")
                .unwrap()
                .to_str()
                .unwrap());
            let a = g.read();
            assert_eq!(a.child_session.as_deref(), Some("child-new"));
            assert_eq!(a.presence_state(), PresenceState::LiveIdle);
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn headless_coordinator_presence_links_all_owned_beads_without_activating_them() {
        let mut g = Ground::new();
        g.input.fields["metadata"]["qrclipDispatch"] = Value::Null;
        let stat = fs::read_to_string("/proc/self/stat").unwrap();
        g.frame["workers"] = json!([{"session":"parent-a","identity":"process:parent-a","model":"invented/gpt-6.1-sol","presence":"live_busy","execution":"active","source":"public-context","observedAt":Utc::now(),"pid":std::process::id(),"startTicks":stat.rsplit_once(") ").unwrap().1.split_whitespace().nth(19).unwrap(),"pidNamespace":fs::read_link("/proc/self/ns/pid").unwrap().to_str().unwrap()}]);
        g.write();
        let mut second = g.input.clone();
        second.bead_id = "fruit-2".into();
        let batch = Reader::new(g.config.clone()).collect(&[g.input.clone(), second]);
        for a in batch.activities.values() {
            assert_eq!(a.coordinator_presence, Some(PresenceState::LiveBusy));
            assert_eq!(a.coordinator_model_label(), Some("Sol"));
            assert_eq!(a.execution_state(), ExecutionState::Unknown);
            assert_eq!(a.child_session, None);
        }
        assert_eq!(batch.activities.len(), 2);
    }
    #[test]
    fn legacy_receipt_pin_cannot_bypass_a_revoked_prospective_admission() {
        let mut g = Ground::new();
        g.input.fields["metadata"]["qrclipDispatch"]["childSession"] = json!("child-new");
        g.native["status"] = json!("completed");
        g.frame["admissions"][0]["invalid"] = json!(true);
        let a = g.read();
        assert_eq!(a.state, ActivityState::Conflict);
        assert_eq!(a.child_session, None);
        assert!(!a.acceptance_ready);
    }
    #[test]
    fn verified_terminal_task_is_inactive_even_when_worker_presence_is_unavailable() {
        let mut g = Ground::new();
        g.native["status"] = json!("completed");
        g.frame["workers"] = json!([]);
        let a = g.read();
        assert_eq!(a.execution_state(), ExecutionState::Inactive);
        assert_eq!(a.presence_state(), PresenceState::Unknown);
        assert_eq!(a.state, ActivityState::Finished);
        assert_eq!(a.child_session.as_deref(), Some("child-new"));
        assert!(!a.acceptance_ready);
    }
    #[test]
    fn early_native_failures_never_promote_an_unverified_receipt_worker() {
        for case in ["missing", "partial", "unsupported"] {
            let mut g = Ground::new();
            g.input.fields["metadata"]["qrclipDispatch"]["childSession"] = json!("child-new");
            g.write();
            let path = g.config.task_directory.join("st_orchard.json");
            match case {
                "missing" => fs::remove_file(path).unwrap(),
                "partial" => fs::write(path, "{").unwrap(),
                _ => {
                    g.native["version"] = json!(2);
                    fs::write(path, g.native.to_string()).unwrap();
                }
            }
            let a = Reader::new(g.config.clone())
                .collect(std::slice::from_ref(&g.input))
                .activities
                .remove(&("orchard".into(), "fruit-1".into()))
                .unwrap();
            assert_eq!(a.child_session, None, "{case}");
            assert_eq!(a.effective_model, None, "{case}");
            assert_eq!(a.execution_state(), ExecutionState::Unknown, "{case}");
            assert_eq!(a.coordinator.as_deref(), Some("parent-a"));
        }
    }
}
