//! Passive, bounded reader for configured OmO task records.
//!
//! The caller supplies the Beads row fields and current attempt context. This
//! module never invokes a tracker or agent command and never enumerates the
//! task directory. Each requested task is opened by its validated task ID.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

mod sessions;

const MAX_RECORD_BYTES: u64 = 256 * 1024;
const MAX_BATCH_RECORDS: usize = 256;
const MAX_WORKERS_PER_BEAD: usize = 16;
const MAX_STRING: usize = 512;

/// Explicit metadata paths and task-record location for one project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct OmoConfig {
    /// Directory containing `<task_id>.json`; it is read directly, never scanned.
    pub task_directory: PathBuf,
    /// Exact project session-log directory for direct coordinator identity.
    pub session_directory: Option<PathBuf>,
    /// Beads metadata path to the active attempt ID.
    pub attempt_path: String,
    /// Beads metadata path to the dispatch receipt object.
    pub dispatch_path: String,
    /// Optional explicit workflow readiness signal; never inferred from checks.
    pub acceptance_ready_path: Option<String>,
    /// Beads metadata path to the current attempt's check record.
    pub check_path: String,
    /// Maximum age of a task record, in seconds.
    pub freshness_seconds: u64,
    /// Maximum bytes read from one task record.
    pub max_record_bytes: u64,
}

impl Default for OmoConfig {
    fn default() -> Self {
        Self {
            task_directory: PathBuf::new(),
            session_directory: None,
            attempt_path: "metadata.qrclipWork.attempt".into(),
            dispatch_path: "metadata.qrclipDispatch".into(),
            acceptance_ready_path: None,
            check_path: "metadata.qrclipWork.checked".into(),
            freshness_seconds: 120,
            max_record_bytes: MAX_RECORD_BYTES,
        }
    }
}

impl OmoConfig {
    /// Validate project-specific settings before use.
    pub fn validate(&self) -> Result<(), &'static str> {
        if !self.task_directory.is_absolute() {
            return Err("OmO task_directory must be an absolute path");
        }
        if self
            .session_directory
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
        {
            return Err("OmO session_directory must be an absolute path");
        }
        if self.attempt_path.is_empty()
            || self.dispatch_path.is_empty()
            || self.check_path.is_empty()
        {
            return Err("OmO metadata paths must not be empty");
        }
        if self.max_record_bytes == 0 || self.max_record_bytes > MAX_RECORD_BYTES {
            return Err("OmO max_record_bytes must be between 1 and 262144");
        }
        Ok(())
    }
}

/// Normalized state derived from current-attempt evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActivityState {
    Working,
    Finished,
    AwaitingAcceptance,
    Failed,
    Cancelled,
    Unknown,
    Conflict,
}

/// State, identity, provenance and evidence for one bead's current activity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Activity {
    pub state: ActivityState,
    pub project: String,
    pub bead_id: String,
    pub attempt_id: Option<String>,
    pub task_id: Option<String>,
    pub worker_name: Option<String>,
    pub worker_type: Option<String>,
    pub effective_model: Option<String>,
    pub child_session: Option<String>,
    pub coordinator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator_model: Option<String>,
    pub observed_at: Option<DateTime<Utc>>,
    pub fresh: Option<bool>,
    pub acceptance_ready: bool,
    pub evidence: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workers: Vec<Activity>,
}

impl Activity {
    /// Short display label for the effective model, preserving unknown models.
    pub fn model_label(&self) -> Option<&str> {
        self.effective_model.as_deref().map(short_model)
    }

    /// Known worker model, or an explicitly labelled coordinator owner.
    pub fn owner_label(&self) -> Option<String> {
        self.model_label()
            .map(str::to_owned)
            .or_else(|| {
                self.coordinator_model
                    .as_deref()
                    .map(|model| format!("{} (coord)", short_model(model)))
            })
            .or_else(|| {
                self.child_session
                    .as_deref()
                    .map(|id| format!("worker {}", id.chars().take(8).collect::<String>()))
            })
            .or_else(|| {
                self.coordinator
                    .as_deref()
                    .map(|id| format!("coord {}", id.chars().take(8).collect::<String>()))
            })
    }

    /// Human-readable state for a detail pane.
    pub fn state_label(&self) -> &'static str {
        match self.state {
            ActivityState::Working => "Working",
            ActivityState::Finished => "Finished; outcome not inferred",
            ActivityState::AwaitingAcceptance => "Awaiting acceptance",
            ActivityState::Failed => "Failed",
            ActivityState::Cancelled => "Cancelled",
            ActivityState::Unknown => "Activity unknown",
            ActivityState::Conflict => "Conflicting activity evidence",
        }
    }
}

fn short_model(model: &str) -> &str {
    let compact = model.rsplit('/').next().unwrap_or(model);
    match compact {
        "GPT-6 Luna" | "gpt-6-luna" => "Luna",
        "GPT-6.1 Sol" | "gpt-6.1-sol" => "Sol",
        "mixed" => "Mixed models",
        other => other.strip_prefix("gpt-").unwrap_or(other),
    }
}

/// One requested Beads row as generic JSON values or `Bead.row.fields()`.
#[derive(Debug, Clone)]
pub struct BeadInput {
    pub project: String,
    pub bead_id: String,
    pub fields: Value,
    /// Persistent Beads status, if the caller wants it in conflict checks.
    pub bead_status: Option<String>,
}

impl BeadInput {
    pub fn from_bead(project: impl Into<String>, bead: &crate::model::types::Bead) -> Self {
        Self {
            project: project.into(),
            bead_id: bead.id.clone(),
            fields: Value::Object(bead.row.fields()),
            bead_status: Some(format!("{:?}", bead.status)),
        }
    }
}

/// A bounded collection with per-bead results, including missing/unsupported inputs.
#[derive(Debug, Clone, Default)]
pub struct ActivityBatch {
    pub activities: BTreeMap<(String, String), Activity>,
}

/// Cached parsed task records. Call `collect` once per snapshot; repeated task IDs
/// in the batch are read only once. Cache lifetime is the Reader lifetime.
pub struct Reader {
    config: OmoConfig,
    records: BTreeMap<String, CachedRecord>,
    sessions: sessions::Sessions,
}

#[derive(Clone)]
enum CachedRecord {
    Parsed(Value, SystemTime, u64),
    Stale(Value, SystemTime, u64, String),
    Missing,
    Invalid(String),
}

impl Reader {
    pub fn new(config: OmoConfig) -> Self {
        Self {
            config,
            records: BTreeMap::new(),
            sessions: sessions::Sessions::default(),
        }
    }

    /// Collect all supplied beads; at most 256 distinct task files are read.
    pub fn collect(&mut self, inputs: &[BeadInput]) -> ActivityBatch {
        self.sessions.begin();
        let mut batch = ActivityBatch::default();
        let dispatch_path = self.config.dispatch_path.as_str();
        let referenced = inputs
            .iter()
            .flat_map(|input| referenced_task_ids(input, dispatch_path))
            .collect::<std::collections::BTreeSet<_>>();
        self.records
            .retain(|task_id, _| referenced.contains(task_id));
        for input in inputs {
            let mut activity = self.read_one(input);
            self.coordinator_identity(&mut activity);
            if activity.workers.is_empty() {
                self.session_identity(&mut activity);
            }
            for worker in &mut activity.workers {
                self.coordinator_identity(worker);
                self.session_identity(worker);
            }
            if !activity.workers.is_empty() {
                let workers = std::mem::take(&mut activity.workers);
                activity = aggregate(activity, workers);
            }
            if activity.attempt_id.is_none() {
                continue;
            }
            batch
                .activities
                .insert((input.project.clone(), input.bead_id.clone()), activity);
        }
        let mut owners =
            BTreeMap::<(String, String), std::collections::BTreeSet<(String, String)>>::new();
        for (key, activity) in &batch.activities {
            for worker in &activity.workers {
                if let Some(task_id) = &worker.task_id {
                    owners
                        .entry((activity.project.clone(), task_id.clone()))
                        .or_default()
                        .insert(key.clone());
                }
            }
        }
        for ((project, task_id), keys) in owners {
            if keys.len() > 1 {
                for key in keys {
                    if let Some(activity) = batch.activities.get_mut(&key) {
                        activity.evidence.push(format!("task {task_id} is shared by multiple current beads in project {project}; ownership is not exclusive"));
                        for worker in &mut activity.workers {
                            if worker.task_id.as_deref() == Some(task_id.as_str()) {
                                worker.evidence.push(format!("task {task_id} is shared by multiple current beads in project {project}; ownership is not exclusive"));
                            }
                        }
                    }
                }
            }
        }
        batch
    }

    fn coordinator_identity(&mut self, activity: &mut Activity) {
        if activity.attempt_id.as_deref().is_none_or(str::is_empty) {
            return;
        }
        if let Some((directory, session)) = self
            .config
            .session_directory
            .as_ref()
            .zip(activity.coordinator.as_ref())
        {
            match self.sessions.model(directory, session) {
                Ok(model) => {
                    activity.coordinator_model = Some(model);
                    activity.evidence.push(format!("coordinator ownership from current attempt and verified session {session}; ownership may be shared across beads"));
                }
                Err(reason) => activity
                    .evidence
                    .push(format!("coordinator identity unavailable: {reason}")),
            }
        }
    }

    fn session_identity(&mut self, activity: &mut Activity) {
        if activity.attempt_id.as_deref().is_none_or(str::is_empty)
            || activity.effective_model.is_some()
            || activity.state == ActivityState::Conflict
        {
            return;
        }
        let linked = if let Some(task) = &activity.task_id {
            if !safe_id(task) {
                return;
            }
            self.config.task_directory.parent().map(|parent| {
                (
                    parent
                        .join("children")
                        .join(task)
                        .join("sessions")
                        .join(task),
                    activity.child_session.clone(),
                    "worker",
                )
            })
        } else if activity.worker_type.as_deref() == Some("direct") {
            self.config
                .session_directory
                .as_ref()
                .zip(activity.coordinator.as_ref())
                .map(|(directory, session)| {
                    (directory.clone(), Some(session.clone()), "coordinator")
                })
        } else {
            None
        };
        let Some((directory, session, role)) = linked else {
            return;
        };
        let identity = match session {
            Some(session) => self
                .sessions
                .model(&directory, &session)
                .map(|model| (session, model)),
            None => self.sessions.discover(&directory),
        };
        match identity {
            Ok((session, model)) => {
                activity.effective_model = Some(model);
                if role == "worker" {
                    activity.child_session = Some(session.clone());
                }
                activity.evidence.push(format!("{role} model from verified session {session}; identity only, not bead liveness or acceptance"));
            }
            Err(reason) => activity
                .evidence
                .push(format!("{role} identity unavailable: {reason}")),
        }
    }

    fn read_one(&mut self, input: &BeadInput) -> Activity {
        let mut result = empty_activity(input);
        let attempt = path_value(&input.fields, &self.config.attempt_path);
        let attempt_object = attempt.and_then(Value::as_object);
        result.attempt_id = attempt
            .and_then(|value| {
                value
                    .as_str()
                    .or_else(|| value.get("id").and_then(Value::as_str))
            })
            .map(|value| bounded(value.to_owned()));
        if let Some(attempt) = attempt_object {
            result.coordinator = attempt
                .get("coordinator")
                .and_then(Value::as_str)
                .map(|s| bounded(s.to_owned()));
            result.worker_name = attempt
                .get("name")
                .and_then(Value::as_str)
                .map(|s| bounded(s.to_owned()));
            result.worker_type = attempt
                .get("mode")
                .and_then(Value::as_str)
                .map(|s| bounded(s.to_owned()));
        }
        let Some(dispatch) = path_value(&input.fields, &self.config.dispatch_path) else {
            result.evidence.push("dispatch metadata missing".into());
            return result;
        };
        if dispatch.is_null() {
            result.evidence.push("no current dispatch receipt".into());
            return result;
        }
        let receipts: Vec<&Value> = if let Some(tasks) = dispatch.as_array() {
            tasks.iter().collect()
        } else if let Some(tasks) = dispatch.get("tasks") {
            match tasks.as_array() {
                Some(tasks) => tasks.iter().collect(),
                None => {
                    result.state = ActivityState::Conflict;
                    result
                        .evidence
                        .push("dispatch tasks must be an array".into());
                    return result;
                }
            }
        } else {
            vec![dispatch]
        };
        if receipts.is_empty() || receipts.len() > MAX_WORKERS_PER_BEAD {
            result.state = ActivityState::Conflict;
            result.evidence.push(format!(
                "dispatch worker count must be between 1 and {MAX_WORKERS_PER_BEAD}"
            ));
            return result;
        }
        let mut workers = receipts
            .iter()
            .map(|receipt| self.read_receipt(input, result.clone(), receipt))
            .collect::<Vec<_>>();
        let mut task_owners = BTreeMap::<String, usize>::new();
        for worker in &workers {
            if let Some(task_id) = &worker.task_id {
                *task_owners.entry(task_id.clone()).or_default() += 1;
            }
        }
        for worker in &mut workers {
            if worker
                .task_id
                .as_ref()
                .is_some_and(|id| task_owners.get(id).copied().unwrap_or(0) > 1)
            {
                worker.state = ActivityState::Conflict;
                worker
                    .evidence
                    .push("duplicate task receipt within current attempt".into());
            }
        }
        aggregate(result, workers)
    }

    fn read_receipt(
        &mut self,
        input: &BeadInput,
        mut result: Activity,
        receipt: &Value,
    ) -> Activity {
        if receipt.is_array() || receipt.get("tasks").is_some() {
            result.state = ActivityState::Conflict;
            result
                .evidence
                .push("nested worker dispatch is unsupported".into());
            return result;
        }
        let Some(dispatch) = receipt.as_object() else {
            result.state = ActivityState::Conflict;
            result
                .evidence
                .push("worker receipt must be an object".into());
            return result;
        };
        let dispatch_attempt = field(dispatch, "attemptId").and_then(string_value);
        let task_id = field(dispatch, "taskId")
            .and_then(string_value)
            .map(|s| bounded(s.to_owned()));
        let receipt_session = field(dispatch, "childSession")
            .and_then(string_value)
            .map(|s| bounded(s.to_owned()));
        if result
            .attempt_id
            .as_deref()
            .is_none_or(|a| Some(a) != dispatch_attempt)
        {
            result
                .evidence
                .push("dispatch receipt does not match current attempt".into());
            return result;
        }
        result.task_id = task_id.clone();
        result.child_session = receipt_session;
        let Some(task_id) = task_id else {
            result
                .evidence
                .push("current dispatch has no task ID".into());
            return result;
        };
        if !safe_id(&task_id) {
            result.state = ActivityState::Conflict;
            result
                .evidence
                .push("task ID is not a safe filename component".into());
            return result;
        }
        let record = self.record(&task_id);
        let (value, modified, source_stale) = match record {
            CachedRecord::Parsed(value, modified, _) => (value, modified, None),
            CachedRecord::Stale(value, modified, _, reason) => (value, modified, Some(reason)),
            CachedRecord::Missing => {
                result.evidence.push("native task record missing".into());
                return result;
            }
            CachedRecord::Invalid(reason) => {
                result.evidence.push(reason);
                return result;
            }
        };
        let last_known = source_stale.is_some();
        let updated_at = text(&value, "updated_at")
            .and_then(|v| DateTime::parse_from_rfc3339(&v).ok())
            .map(|v| v.with_timezone(&Utc));
        result.observed_at = updated_at.or_else(|| {
            modified
                .duration_since(SystemTime::UNIX_EPOCH)
                .ok()
                .map(|d| DateTime::<Utc>::from(SystemTime::UNIX_EPOCH + d))
        });
        if !value.is_object() {
            result
                .evidence
                .push("unsupported native task record shape".into());
            return result;
        }
        if value
            .get("version")
            .and_then(Value::as_u64)
            .is_some_and(|version| version != 1)
        {
            result
                .evidence
                .push("unsupported native task record version".into());
            return result;
        }
        let Some(record_task) = text(&value, "task_id") else {
            result
                .evidence
                .push("native task record has no task_id".into());
            return result;
        };
        let record_project = text(&value, "project");
        let record_bead = text(&value, "bead_id");
        let record_attempt = text(&value, "attempt_id");
        let mut conflicts = Vec::new();
        if record_task != task_id {
            conflicts.push("task ID mismatch");
        }
        if record_project
            .as_deref()
            .is_some_and(|v| v != input.project)
        {
            conflicts.push("project mismatch");
        }
        if record_bead.as_deref().is_some_and(|v| v != input.bead_id) {
            conflicts.push("bead ID mismatch");
        }
        if record_attempt
            .as_deref()
            .is_some_and(|v| Some(v) != result.attempt_id.as_deref())
        {
            conflicts.push("attempt mismatch");
        }
        let record_coordinator =
            text(&value, "coordinator").or_else(|| text(&value, "parent_session_id"));
        if record_coordinator
            .as_deref()
            .zip(result.coordinator.as_deref())
            .is_some_and(|(a, b)| a != b)
        {
            conflicts.push("coordinator mismatch");
        }
        let record_session = text(&value, "child_session_id");
        if record_session
            .as_deref()
            .zip(result.child_session.as_deref())
            .is_some_and(|(a, b)| a != b)
        {
            conflicts.push("child session mismatch");
        }
        if !conflicts.is_empty() {
            result.state = ActivityState::Conflict;
            result
                .evidence
                .extend(conflicts.into_iter().map(str::to_owned));
            return result;
        }
        result.effective_model = value
            .get("effective_model")
            .and_then(model_string)
            .or_else(|| value.get("resolved_model").and_then(model_string))
            .or_else(|| text(&value, "model"))
            .or_else(|| text(&value, "effectiveModel"))
            .map(bounded);
        result.worker_type = text(&value, "agent_type")
            .or_else(|| text(&value, "workerType"))
            .or(result.worker_type)
            .map(bounded);
        result.worker_name = text(&value, "name")
            .or_else(|| text(&value, "workerName"))
            .or(result.worker_name)
            .map(bounded);
        result.child_session = record_session.or(result.child_session).map(bounded);
        result.coordinator = record_coordinator.or(result.coordinator).map(bounded);
        let Some(native_status) = text(&value, "status") else {
            result
                .evidence
                .push("native task record has no status".into());
            return result;
        };
        result.state = match native_status.as_str() {
            "running" | "working" => ActivityState::Working,
            "completed" | "finished" => ActivityState::Finished,
            "failed" | "error" => ActivityState::Failed,
            "cancelled" | "canceled" => ActivityState::Cancelled,
            _ => {
                result
                    .evidence
                    .push(format!("unsupported native task status: {native_status}"));
                ActivityState::Unknown
            }
        };
        if let Some(reason) = source_stale {
            result.evidence.push(reason);
            if result.state == ActivityState::Working {
                result.state = ActivityState::Unknown;
                result
                    .evidence
                    .push("cached running task is last-known, not live".into());
            }
        }
        result.fresh = if last_known {
            Some(false)
        } else if result.state == ActivityState::Working {
            updated_at
                .and_then(|timestamp| Utc::now().signed_duration_since(timestamp).to_std().ok())
                .map(|age| age.as_secs() <= self.config.freshness_seconds)
        } else {
            None
        };
        let check = current_check(
            input,
            &self.config.check_path,
            &self.config.attempt_path,
            result.attempt_id.as_deref(),
        );
        let readiness = self
            .config
            .acceptance_ready_path
            .as_deref()
            .and_then(|path| path_value(&input.fields, path));
        let readiness_for_attempt = readiness.and_then(Value::as_object).is_some_and(|ready| {
            ready.get("ready") == Some(&Value::Bool(true))
                && ready.get("attemptId").and_then(Value::as_str) == result.attempt_id.as_deref()
        });
        result.acceptance_ready =
            readiness_for_attempt && result.state == ActivityState::Finished && check == Some(true);
        if readiness_for_attempt && !result.acceptance_ready {
            result.state = ActivityState::Conflict;
            result.evidence.push("acceptance readiness is not bound to a completed current task with passing current checks".into());
        } else if result.acceptance_ready {
            result.state = ActivityState::AwaitingAcceptance;
        }
        result
            .evidence
            .push("matched current-attempt native task record".into());
        if matches!(result.state, ActivityState::Finished) {
            result
                .evidence
                .push("completion does not establish success or acceptance".into());
        }
        if check == Some(false) {
            result
                .evidence
                .push("current recorded check failed; task completion does not override it".into());
        }
        if result.state == ActivityState::Working && result.fresh != Some(true) {
            result.state = ActivityState::Unknown;
            result
                .evidence
                .push("running task record is stale; file time is not a heartbeat".into());
        }
        if input
            .bead_status
            .as_deref()
            .is_some_and(|s| s.eq_ignore_ascii_case("closed"))
            && result.state == ActivityState::Working
        {
            result.state = ActivityState::Conflict;
            result
                .evidence
                .push("closed Bead has a working current task".into());
        }
        result
    }

    fn record(&mut self, task_id: &str) -> CachedRecord {
        let path = self.config.task_directory.join(format!("{task_id}.json"));
        let stamp = fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok().map(|t| (t, m.len())));
        if let Some(cached) = self.records.get(task_id) {
            if let Some((modified, len)) = stamp {
                let same = match cached {
                    CachedRecord::Parsed(_, old_modified, old_len)
                    | CachedRecord::Stale(_, old_modified, old_len, _) => {
                        modified == *old_modified && len == *old_len
                    }
                    _ => false,
                };
                if same {
                    return cached.clone();
                }
            } else if matches!(cached, CachedRecord::Missing) {
                return cached.clone();
            }
        }
        if self.records.len() >= MAX_BATCH_RECORDS && !self.records.contains_key(task_id) {
            return CachedRecord::Invalid(format!(
                "collection task-read limit ({MAX_BATCH_RECORDS}) exceeded"
            ));
        }
        let previous = self.records.get(task_id).and_then(|record| match record {
            CachedRecord::Parsed(value, modified, _)
            | CachedRecord::Stale(value, modified, _, _) => Some((value.clone(), *modified)),
            _ => None,
        });
        let record = match read_bounded(&path, self.config.max_record_bytes.min(MAX_RECORD_BYTES)) {
            Ok(Some((bytes, modified))) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => CachedRecord::Parsed(value, modified, bytes.len() as u64),
                Err(_) => previous.map_or_else(
                    || CachedRecord::Invalid("partial or invalid task JSON".into()),
                    |(value, old_modified)| {
                        CachedRecord::Stale(
                            value,
                            old_modified,
                            bytes.len() as u64,
                            "partial or invalid task JSON; showing last-known record".into(),
                        )
                    },
                ),
            },
            Ok(None) => previous.map_or(CachedRecord::Missing, |(value, modified)| {
                CachedRecord::Stale(
                    value,
                    modified,
                    0,
                    "native task record missing; showing last-known record".into(),
                )
            }),
            Err(reason) => previous.map_or_else(
                || CachedRecord::Invalid(reason.clone()),
                |(value, modified)| {
                    CachedRecord::Stale(
                        value,
                        modified,
                        stamp.map_or(0, |(_, len)| len),
                        format!("{reason}; showing last-known record"),
                    )
                },
            ),
        };
        self.records.insert(task_id.to_owned(), record.clone());
        record
    }
}

fn empty_activity(input: &BeadInput) -> Activity {
    Activity {
        state: ActivityState::Unknown,
        project: input.project.clone(),
        bead_id: input.bead_id.clone(),
        attempt_id: None,
        task_id: None,
        worker_name: None,
        worker_type: None,
        effective_model: None,
        child_session: None,
        coordinator: None,
        coordinator_model: None,
        observed_at: None,
        fresh: None,
        acceptance_ready: false,
        evidence: Vec::new(),
        workers: Vec::new(),
    }
}

fn aggregate(base: Activity, workers: Vec<Activity>) -> Activity {
    if workers.len() == 1 {
        let mut activity = workers[0].clone();
        activity.workers = workers;
        return activity;
    }
    let mut activity = base;
    let states = workers
        .iter()
        .map(|worker| worker.state)
        .collect::<Vec<_>>();
    activity.state = if states.contains(&ActivityState::Conflict) {
        ActivityState::Conflict
    } else if states.contains(&ActivityState::Failed) {
        ActivityState::Failed
    } else if states.contains(&ActivityState::Unknown) {
        ActivityState::Unknown
    } else if states.contains(&ActivityState::Working) {
        ActivityState::Working
    } else if states
        .iter()
        .all(|state| *state == ActivityState::AwaitingAcceptance)
    {
        ActivityState::AwaitingAcceptance
    } else if states.iter().all(|state| {
        *state == ActivityState::Finished || *state == ActivityState::AwaitingAcceptance
    }) {
        ActivityState::Finished
    } else if states
        .iter()
        .all(|state| *state == ActivityState::Cancelled)
    {
        ActivityState::Cancelled
    } else {
        ActivityState::Unknown
    };
    if states.contains(&ActivityState::Finished) && states.contains(&ActivityState::Cancelled) {
        activity.state = ActivityState::Unknown;
        activity
            .evidence
            .push("workers ended with mixed completed and cancelled outcomes".into());
    }
    let models = workers
        .iter()
        .filter_map(|worker| worker.effective_model.as_deref())
        .collect::<std::collections::BTreeSet<_>>();
    activity.effective_model = if models.len() > 1 {
        Some("mixed".into())
    } else {
        models.iter().next().map(|model| (*model).to_owned())
    };
    if models.len() > 1 {
        activity
            .evidence
            .push("current workers use mixed effective models".into());
    }
    activity.task_id = (workers.len() == 1)
        .then(|| workers[0].task_id.clone())
        .flatten();
    activity.worker_name = (workers.len() == 1)
        .then(|| workers[0].worker_name.clone())
        .flatten();
    activity.worker_type = (workers.len() == 1)
        .then(|| workers[0].worker_type.clone())
        .flatten();
    activity.child_session = (workers.len() == 1)
        .then(|| workers[0].child_session.clone())
        .flatten();
    activity.coordinator = (workers.len() == 1)
        .then(|| workers[0].coordinator.clone())
        .flatten()
        .or(activity.coordinator.clone());
    activity.observed_at = workers.iter().filter_map(|worker| worker.observed_at).max();
    activity.fresh = if workers.iter().any(|worker| worker.fresh == Some(false)) {
        Some(false)
    } else if activity.state == ActivityState::Working {
        Some(
            workers
                .iter()
                .filter(|worker| worker.state == ActivityState::Working)
                .all(|worker| worker.fresh == Some(true)),
        )
    } else {
        None
    };
    activity.acceptance_ready =
        !workers.is_empty() && workers.iter().all(|worker| worker.acceptance_ready);
    activity.attempt_id = workers
        .first()
        .and_then(|worker| worker.attempt_id.clone())
        .or(activity.attempt_id);
    if workers.len() > 1 {
        for (index, worker) in workers.iter().enumerate() {
            for evidence in &worker.evidence {
                activity
                    .evidence
                    .push(format!("worker {}: {evidence}", index + 1));
            }
        }
        activity.evidence.push(format!(
            "aggregate of {} current workers; details retain each worker",
            workers.len()
        ));
    }
    activity.workers = workers;
    activity
}

fn read_bounded(path: &Path, limit: u64) -> Result<Option<(Vec<u8>, SystemTime)>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("task record unavailable".into()),
    };
    if !meta.is_file() {
        return Err("task record is not a regular file".into());
    }
    if meta.len() > limit {
        return Err("task record exceeds configured byte limit".into());
    }
    let mut file = fs::File::open(path).map_err(|_| "task record unavailable".to_owned())?;
    let opened = file
        .metadata()
        .map_err(|_| "task record unavailable".to_owned())?;
    if opened.len() > limit {
        return Err("task record exceeds configured byte limit".into());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.by_ref()
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| "task record unavailable".to_owned())?;
    if bytes.len() as u64 > limit {
        return Err("task record grew beyond configured byte limit".into());
    }
    let after = fs::metadata(path).map_err(|_| "task record changed during read".to_owned())?;
    if after.len() != opened.len() || after.modified().ok() != opened.modified().ok() {
        return Err("task record changed during read".into());
    }
    Ok(Some((
        bytes,
        opened.modified().unwrap_or(SystemTime::UNIX_EPOCH),
    )))
}
fn path_value<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let mut value = root;
    for part in path.split('.') {
        value = value.get(part)?;
    }
    Some(value)
}
fn referenced_task_ids(input: &BeadInput, dispatch_path: &str) -> Vec<String> {
    let Some(dispatch) = path_value(&input.fields, dispatch_path) else {
        return Vec::new();
    };
    let receipts = dispatch
        .as_array()
        .or_else(|| dispatch.get("tasks").and_then(Value::as_array));
    match receipts {
        Some(receipts) => receipts
            .iter()
            .filter_map(|receipt| {
                receipt
                    .get("taskId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect(),
        None => dispatch
            .get("taskId")
            .and_then(Value::as_str)
            .map(|id| vec![id.to_owned()])
            .unwrap_or_default(),
    }
}
fn current_check(
    input: &BeadInput,
    path: &str,
    attempt_path: &str,
    attempt_id: Option<&str>,
) -> Option<bool> {
    let check = path_value(&input.fields, path)?.as_object()?;
    let passed = check.get("passed")?.as_bool()?;
    let checked = check
        .get("checkedAt")
        .and_then(Value::as_str)
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok());
    let check_attempt = check.get("attemptId").and_then(Value::as_str);
    if let Some(check_attempt) = check_attempt {
        return (Some(check_attempt) == attempt_id).then_some(passed);
    }
    let attempt = path_value(&input.fields, attempt_path)?;
    let prepared = attempt
        .get("preparedAt")
        .and_then(Value::as_str)
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok());
    let now = Utc::now();
    prepared
        .zip(checked)
        .is_some_and(|(prepared, checked)| checked >= prepared && checked <= now)
        .then_some(passed)
}
fn field<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a Value> {
    object.get(key)
}
fn string_value(value: &Value) -> Option<&str> {
    value.as_str()
}
fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
fn model_string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned).or_else(|| {
        let model = value.get("display").and_then(Value::as_str);
        if let Some(model) = model {
            return Some(model.to_owned());
        }
        let provider = value.get("provider").and_then(Value::as_str)?;
        let model = value.get("model_id").and_then(Value::as_str)?;
        Some(format!("{provider}/{model}"))
    })
}
fn bounded(value: String) -> String {
    value.chars().take(MAX_STRING).collect()
}
fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
        && value != "."
        && value != ".."
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);
    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "beady-eye-omo-{label}-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn record(status: &str) -> Value {
        serde_json::json!({"task_id":"task-1","parent_session_id":"coord-1","child_session_id":"session-1","name":"worker","agent_type":"agent","model":"chatgpt-subscription/gpt-6-luna","effective_model":{"provider":"chatgpt-subscription","model_id":"gpt-6-luna","display":"chatgpt-subscription/gpt-6-luna","source":"runtime"},"resolved_model":{"provider":"chatgpt-subscription","model_id":"gpt-6-luna","display":"chatgpt-subscription/gpt-6-luna","source":"runtime"},"status":status,"created_at":"2026-11-13T10:00:00Z","updated_at":Utc::now().to_rfc3339(),"started_at":"2026-11-13T10:00:01Z","terminal_at":null,"execution_mode":"worker","residency_state":"active","spawn_spec":{"cwd":"/invented/work","prompt":"invented prompt"}})
    }
    fn input() -> BeadInput {
        BeadInput {
            project: "demo".into(),
            bead_id: "demo-1".into(),
            bead_status: Some("InProgress".into()),
            fields: serde_json::json!({"metadata":{"qrclipWork":{"attempt":{"id":"attempt-1","coordinator":"coord-1","name":"worker","mode":"worker","preparedAt":"2026-11-13T09:00:00Z"}},"qrclipDispatch":{"attemptId":"attempt-1","taskId":"task-1","childSession":"session-1","nativeStatus":"running","outcome":null}}}),
        }
    }
    fn input_for(bead_id: &str) -> BeadInput {
        let mut row = input();
        row.bead_id = bead_id.to_owned();
        row
    }
    fn reader_with(value: Value) -> Reader {
        let dir = temp_dir("record");
        let _ = fs::create_dir_all(&dir);
        fs::write(dir.join("task-1.json"), serde_json::to_vec(&value).unwrap()).unwrap();
        Reader::new(OmoConfig {
            task_directory: dir,
            freshness_seconds: 3600,
            ..Default::default()
        })
    }
    fn multi_reader(statuses: &[&str]) -> (Reader, BeadInput) {
        let dir = temp_dir("multi");
        fs::create_dir_all(&dir).unwrap();
        let mut receipts = Vec::new();
        for (index, status) in statuses.iter().enumerate() {
            let task_id = format!("worker-{index}");
            let mut task = record(status);
            task["task_id"] = Value::String(task_id.clone());
            task["child_session_id"] = Value::String(format!("child-{index}"));
            if index % 2 == 1 {
                task["effective_model"]["model_id"] = Value::String("gpt-6.1-sol".into());
                task["effective_model"]["display"] = Value::String("provider/gpt-6.1-sol".into());
            }
            fs::write(
                dir.join(format!("{task_id}.json")),
                serde_json::to_vec(&task).unwrap(),
            )
            .unwrap();
            receipts.push(serde_json::json!({"attemptId":"attempt-1","taskId":task_id,"childSession":format!("child-{index}")}));
        }
        let mut row = input();
        row.fields["metadata"]["qrclipDispatch"] = Value::Array(receipts);
        (
            Reader::new(OmoConfig {
                task_directory: dir,
                freshness_seconds: 3600,
                ..Default::default()
            }),
            row,
        )
    }
    #[test]
    fn direct_session_identity_does_not_claim_execution_or_acceptance() {
        let dir = temp_dir("direct-session");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("invented_coord-1.jsonl"), "{\"type\":\"session\",\"version\":3,\"id\":\"coord-1\"}\n{\"type\":\"model_change\",\"provider\":\"invented\",\"modelId\":\"gpt-6.1-sol\"}\n").unwrap();
        let mut row = input();
        row.fields["metadata"]["qrclipDispatch"] = Value::Null;
        row.fields["metadata"]["qrclipWork"]["attempt"]["mode"] = "direct".into();
        let mut reader = Reader::new(OmoConfig {
            task_directory: dir.join("tasks"),
            session_directory: Some(dir.clone()),
            ..Default::default()
        });
        let activity = reader
            .collect(&[row.clone()])
            .activities
            .into_values()
            .next()
            .unwrap();
        assert_eq!(activity.model_label(), Some("Sol"));
        assert_eq!(activity.state, ActivityState::Unknown);
        assert_eq!(activity.fresh, None);
        assert!(!activity.acceptance_ready);
        assert!(activity
            .evidence
            .iter()
            .any(|e| e.contains("identity only")));
        let mut second = row.clone();
        second.bead_id = "demo-2".into();
        second.fields["metadata"]["qrclipWork"]["attempt"]["id"] = "attempt-2".into();
        let shared = reader.collect(&[row.clone(), second]);
        assert_eq!(shared.activities.len(), 2);
        assert!(shared
            .activities
            .values()
            .all(|a| a.model_label() == Some("Sol") && a.state == ActivityState::Unknown));
        row.fields["metadata"]["qrclipWork"]["attempt"]["mode"] = "delegate".into();
        let activity = reader
            .collect(&[row])
            .activities
            .into_values()
            .next()
            .unwrap();
        assert_eq!(
            activity.effective_model, None,
            "coordinator is not the delegated worker"
        );
        assert_eq!(activity.owner_label().as_deref(), Some("Sol (coord)"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_native_record_can_resolve_its_own_worker_log_without_coordinator_substitution() {
        let root = temp_dir("worker-session");
        let directory = root.join("children/task-1/sessions/task-1");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("invented_worker-session.jsonl"), "{\"type\":\"session\",\"version\":3,\"id\":\"worker-session\"}\n{\"type\":\"model_change\",\"provider\":\"invented\",\"modelId\":\"gpt-6-luna\"}\n").unwrap();
        let mut reader = Reader::new(OmoConfig {
            task_directory: root.join("tasks"),
            ..Default::default()
        });
        let mut row = input();
        row.fields["metadata"]["qrclipDispatch"]["childSession"] = Value::Null;
        let activity = reader
            .collect(&[row.clone()])
            .activities
            .into_values()
            .next()
            .unwrap();
        assert_eq!(activity.model_label(), Some("Luna"));
        assert_eq!(activity.child_session.as_deref(), Some("worker-session"));
        assert_eq!(activity.state, ActivityState::Unknown);
        assert!(!activity.acceptance_ready);
        row.fields["metadata"]["qrclipDispatch"]["attemptId"] = "old-attempt".into();
        let activity = reader
            .collect(&[row])
            .activities
            .into_values()
            .next()
            .unwrap();
        assert_eq!(
            activity.effective_model, None,
            "stale attempt cannot claim the worker log"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn matched_completion_is_finished_not_success_or_acceptance() {
        let activity = reader_with(record("completed"))
            .collect(&[input()])
            .activities
            .remove(&("demo".into(), "demo-1".into()))
            .unwrap();
        assert_eq!(activity.state, ActivityState::Finished);
        assert!(!activity.acceptance_ready);
        assert!(activity
            .evidence
            .iter()
            .any(|e| e.contains("does not establish success")));
        assert_eq!(activity.model_label(), Some("Luna"));
    }
    #[test]
    fn completed_task_keeps_failed_current_check_visible() {
        let mut row = input();
        row.fields["metadata"]["qrclipWork"]["checked"] = serde_json::json!({"attemptId":"attempt-1","passed":false,"checkedAt":"2026-11-13T12:00:00Z"});
        let activity = reader_with(record("completed"))
            .collect(&[row])
            .activities
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(activity.state, ActivityState::Finished);
        assert!(!activity.acceptance_ready);
        assert!(activity
            .evidence
            .iter()
            .any(|item| item.contains("check failed")));
    }

    #[test]
    fn one_worker_can_own_multiple_current_beads() {
        let first = input();
        let mut second = input_for("demo-2");
        second.fields["metadata"]["qrclipWork"]["attempt"]["id"] =
            Value::String("attempt-2".into());
        second.fields["metadata"]["qrclipDispatch"]["attemptId"] =
            Value::String("attempt-2".into());
        let batch = reader_with(record("running")).collect(&[first, second]);
        assert_eq!(batch.activities.len(), 2);
        assert!(batch
            .activities
            .values()
            .all(|activity| activity.state == ActivityState::Working
                && activity.model_label() == Some("Luna")));
        assert!(batch.activities.values().all(|a| a
            .evidence
            .iter()
            .any(|e| e.contains("ownership is not exclusive"))));
    }

    #[test]
    fn multiple_current_workers_on_distinct_tasks_remain_distinguishable() {
        let dir = temp_dir("workers");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("task-1.json"),
            serde_json::to_vec(&record("running")).unwrap(),
        )
        .unwrap();
        let mut second_task = record("running");
        second_task["task_id"] = Value::String("task-2".into());
        second_task["child_session_id"] = Value::String("session-2".into());
        second_task["name"] = Value::String("worker-two".into());
        fs::write(
            dir.join("task-2.json"),
            serde_json::to_vec(&second_task).unwrap(),
        )
        .unwrap();
        let mut second = input_for("demo-2");
        second.fields["metadata"]["qrclipWork"]["attempt"]["id"] =
            Value::String("attempt-2".into());
        second.fields["metadata"]["qrclipDispatch"]["attemptId"] =
            Value::String("attempt-2".into());
        second.fields["metadata"]["qrclipDispatch"]["taskId"] = Value::String("task-2".into());
        second.fields["metadata"]["qrclipDispatch"]["childSession"] =
            Value::String("session-2".into());
        let batch = Reader::new(OmoConfig {
            task_directory: dir,
            freshness_seconds: 3600,
            ..Default::default()
        })
        .collect(&[input(), second]);
        assert_eq!(batch.activities.len(), 2);
        assert!(batch
            .activities
            .values()
            .all(|activity| activity.state == ActivityState::Working));
        assert_ne!(
            batch.activities[&("demo".into(), "demo-1".into())].child_session,
            batch.activities[&("demo".into(), "demo-2".into())].child_session
        );
    }

    #[test]
    fn same_bead_worker_aggregation_has_deterministic_precedence_and_mixed_models() {
        let (mut reader, mut row) = multi_reader(&["running", "completed"]);
        let receipts = row.fields["metadata"]["qrclipDispatch"].take();
        row.fields["metadata"]["qrclipDispatch"] = serde_json::json!({"tasks":receipts});
        let activity = reader
            .collect(&[row])
            .activities
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(activity.state, ActivityState::Working);
        assert_eq!(activity.workers.len(), 2);
        assert_eq!(activity.model_label(), Some("Mixed models"));
        assert!(activity
            .workers
            .iter()
            .all(|worker| worker.workers.is_empty()));

        let (mut reader, row) = multi_reader(&["error", "running"]);
        assert_eq!(
            reader
                .collect(&[row])
                .activities
                .values()
                .next()
                .unwrap()
                .state,
            ActivityState::Failed
        );
        let (mut reader, row) = multi_reader(&["completed", "completed"]);
        assert_eq!(
            reader
                .collect(&[row])
                .activities
                .values()
                .next()
                .unwrap()
                .state,
            ActivityState::Finished
        );
        let (mut reader, row) = multi_reader(&["completed", "cancelled"]);
        assert_eq!(
            reader
                .collect(&[row])
                .activities
                .values()
                .next()
                .unwrap()
                .state,
            ActivityState::Unknown
        );
    }

    #[test]
    fn all_workers_require_attempt_bound_readiness() {
        let (mut reader, mut row) = multi_reader(&["completed", "completed"]);
        row.fields["metadata"]["readyForAcceptance"] =
            serde_json::json!({"attemptId":"attempt-1","ready":true});
        row.fields["metadata"]["qrclipWork"]["checked"] =
            serde_json::json!({"attemptId":"attempt-1","passed":true});
        reader.config.acceptance_ready_path = Some("metadata.readyForAcceptance".into());
        let activity = reader
            .collect(&[row])
            .activities
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(activity.state, ActivityState::AwaitingAcceptance);
        assert!(activity.acceptance_ready);
        assert!(activity
            .workers
            .iter()
            .all(|worker| worker.state == ActivityState::AwaitingAcceptance));
    }

    #[test]
    fn duplicate_workers_inside_a_bead_conflict_and_nested_arrays_reject() {
        let (mut reader, mut row) = multi_reader(&["running", "running"]);
        row.fields["metadata"]["qrclipDispatch"][1]["taskId"] = Value::String("worker-0".into());
        let activity = reader
            .collect(&[row])
            .activities
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(activity.state, ActivityState::Conflict);
        assert!(activity
            .workers
            .iter()
            .all(|worker| worker.state == ActivityState::Conflict));

        let (mut reader, mut row) = multi_reader(&["running"]);
        row.fields["metadata"]["qrclipDispatch"] =
            serde_json::json!([[{"attemptId":"attempt-1","taskId":"worker-0"}]]);
        assert_eq!(
            reader
                .collect(&[row])
                .activities
                .values()
                .next()
                .unwrap()
                .state,
            ActivityState::Conflict
        );
    }

    #[test]
    fn stale_receipt_does_not_claim_task_or_conflict_with_current_owner() {
        let (mut reader, current) = multi_reader(&["completed"]);
        let mut stale = current.clone();
        stale.bead_id = "demo-stale".into();
        stale.fields["metadata"]["qrclipDispatch"][0]["attemptId"] =
            Value::String("old-attempt".into());
        let batch = reader.collect(&[stale, current.clone()]);
        assert_eq!(
            batch.activities[&("demo".into(), "demo-stale".into())].state,
            ActivityState::Unknown
        );
        assert_eq!(
            batch.activities[&("demo".into(), "demo-stale".into())].workers[0].task_id,
            None
        );
        assert_eq!(
            batch.activities[&("demo".into(), "demo-1".into())].state,
            ActivityState::Finished
        );
    }

    #[test]
    fn no_attempt_and_null_dispatch_do_not_create_conflicts() {
        let mut no_attempt = input();
        no_attempt.fields["metadata"]["qrclipWork"] = Value::Null;
        let mut no_dispatch = input_for("demo-2");
        no_dispatch.fields["metadata"]["qrclipDispatch"] = Value::Null;
        let batch = reader_with(record("running")).collect(&[no_attempt, no_dispatch]);
        assert_eq!(batch.activities.len(), 1);
        assert_eq!(
            batch.activities.values().next().unwrap().state,
            ActivityState::Unknown
        );
    }
    #[test]
    fn prior_attempt_receipt_and_record_mismatches_do_not_match() {
        let mut old = input();
        old.fields["metadata"]["qrclipWork"]["attempt"]["id"] = Value::String("attempt-2".into());
        let activity = reader_with(record("running"))
            .collect(&[old])
            .activities
            .remove(&("demo".into(), "demo-1".into()))
            .unwrap();
        assert_eq!(activity.state, ActivityState::Unknown);
        let mut wrong = record("running");
        wrong["parent_session_id"] = Value::String("other".into());
        let activity = reader_with(wrong)
            .collect(&[input()])
            .activities
            .remove(&("demo".into(), "demo-1".into()))
            .unwrap();
        assert_eq!(activity.state, ActivityState::Conflict);
    }
    #[test]
    fn missing_and_unsupported_records_degrade_explicitly() {
        let dir = temp_dir("missing");
        let mut reader = Reader::new(OmoConfig {
            task_directory: dir,
            ..Default::default()
        });
        assert_eq!(
            reader
                .collect(&[input()])
                .activities
                .values()
                .next()
                .unwrap()
                .state,
            ActivityState::Unknown
        );
        assert!(reader_with(Value::Array(vec![]))
            .collect(&[input()])
            .activities
            .values()
            .next()
            .unwrap()
            .evidence
            .iter()
            .any(|item| item.contains("unsupported native task")));
    }
    #[test]
    fn acceptance_requires_explicit_ready_evidence() {
        let dir = temp_dir("ready");
        let _ = fs::create_dir_all(&dir);
        fs::write(
            dir.join("task-1.json"),
            serde_json::to_vec(&record("completed")).unwrap(),
        )
        .unwrap();
        let mut row = input();
        row.fields["metadata"]["readyForAcceptance"] =
            serde_json::json!({"attemptId":"attempt-1","ready":true});
        row.fields["metadata"]["qrclipWork"]["checked"] = serde_json::json!({"attemptId":"attempt-1","passed":true,"checkedAt":"2026-11-13T12:00:00Z"});
        let activity = Reader::new(OmoConfig {
            task_directory: dir,
            freshness_seconds: 3600,
            acceptance_ready_path: Some("metadata.readyForAcceptance".into()),
            ..Default::default()
        })
        .collect(&[row])
        .activities
        .values()
        .next()
        .unwrap()
        .clone();
        assert_eq!(activity.state, ActivityState::AwaitingAcceptance);
        assert!(activity.acceptance_ready);
    }

    #[test]
    fn readiness_requires_a_current_explicitly_passing_check() {
        let cases = [
            (None, "missing check"),
            (
                Some(serde_json::json!({"attemptId":"old-attempt","passed":true})),
                "wrong attempt",
            ),
            (
                Some(serde_json::json!({"attemptId":"attempt-1","passed":"yes"})),
                "malformed check",
            ),
            (
                Some(serde_json::json!({"attemptId":"attempt-1","passed":false})),
                "failed check",
            ),
        ];
        for (check, _label) in cases {
            let dir = temp_dir("ready-check");
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("task-1.json"),
                serde_json::to_vec(&record("completed")).unwrap(),
            )
            .unwrap();
            let mut row = input();
            row.fields["metadata"]["readyForAcceptance"] =
                serde_json::json!({"attemptId":"attempt-1","ready":true});
            if let Some(check) = check {
                row.fields["metadata"]["qrclipWork"]["checked"] = check;
            }
            let activity = Reader::new(OmoConfig {
                task_directory: dir,
                freshness_seconds: 3600,
                acceptance_ready_path: Some("metadata.readyForAcceptance".into()),
                ..Default::default()
            })
            .collect(&[row])
            .activities
            .values()
            .next()
            .unwrap()
            .clone();
            assert_ne!(
                activity.state,
                ActivityState::AwaitingAcceptance,
                "{_label}"
            );
            assert!(!activity.acceptance_ready, "{_label}");
        }
    }
    #[test]
    fn age_is_reported_and_not_treated_as_liveness() {
        let dir = temp_dir("stale");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("task-1.json"),
            serde_json::to_vec(&record("running")).unwrap(),
        )
        .unwrap();
        let mut old = record("running");
        old["updated_at"] = Value::String("2020-01-01T00:00:00Z".into());
        fs::write(dir.join("task-1.json"), serde_json::to_vec(&old).unwrap()).unwrap();
        let mut reader = Reader::new(OmoConfig {
            task_directory: dir.clone(),
            freshness_seconds: 0,
            ..Default::default()
        });
        assert_eq!(
            reader
                .collect(&[input()])
                .activities
                .values()
                .next()
                .unwrap()
                .state,
            ActivityState::Unknown
        );
    }

    #[test]
    fn reader_reloads_changed_task_file_and_keeps_terminal_history() {
        let dir = temp_dir("refresh");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("task-1.json");
        fs::write(&path, serde_json::to_vec(&record("completed")).unwrap()).unwrap();
        let mut reader = Reader::new(OmoConfig {
            task_directory: dir,
            freshness_seconds: 0,
            ..Default::default()
        });
        assert_eq!(
            reader
                .collect(&[input()])
                .activities
                .values()
                .next()
                .unwrap()
                .state,
            ActivityState::Finished
        );
        fs::write(&path, b"{partial").unwrap();
        let last_known = reader
            .collect(&[input()])
            .activities
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(last_known.state, ActivityState::Finished);
        assert_eq!(last_known.fresh, Some(false));
        assert!(last_known
            .evidence
            .iter()
            .any(|item| item.contains("last-known record")));
        fs::remove_file(&path).unwrap();
        let missing = reader
            .collect(&[input()])
            .activities
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(missing.state, ActivityState::Finished);
        assert_eq!(missing.fresh, Some(false));
        assert!(missing
            .evidence
            .iter()
            .any(|item| item.contains("record missing")));
        let mut finished = record("error");
        finished["updated_at"] = Value::String(Utc::now().to_rfc3339());
        fs::write(path, serde_json::to_vec(&finished).unwrap()).unwrap();
        let activity = reader
            .collect(&[input()])
            .activities
            .values()
            .next()
            .unwrap()
            .clone();
        assert_eq!(activity.state, ActivityState::Failed);
        assert_eq!(activity.fresh, None);
    }
}
