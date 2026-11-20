//! Read decisions from the explicitly configured, user-installed work CLI.

use super::{empty_activity, ActivityBatch, BeadInput, OmoConfig};
use crate::config::Project;
use serde::Deserialize;
use std::io::{self, Read};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::{env, thread};

const MAX_REPLY_BYTES: usize = 4096;
// The work CLI allows up to three seconds for its local store probe.
const POLICY_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Level {
    Disabled,
    Observation,
    Management,
    Delegation,
}

#[derive(Deserialize)]
struct Reply {
    version: u32,
    project: Option<PathBuf>,
    level: Level,
    source: String,
    reason: Option<String>,
}

pub(crate) enum WorkPolicy {
    Allowed {
        config: Box<OmoConfig>,
        evidence: String,
    },
    Denied(String),
}

impl WorkPolicy {
    /// No executable means legacy passive reading. A configured failure is a denial.
    pub(crate) fn inspect(
        config: &OmoConfig,
        project: &Project,
        viewed: &[Project],
    ) -> Option<Self> {
        config.work_policy_executable.as_ref()?;
        Some(evaluate(config, project, viewed).unwrap_or_else(|error| {
            Self::Denied(format!("Work policy: disabled (viewer): {error:#}"))
        }))
    }

    pub(crate) fn reader_config(&self) -> Option<&OmoConfig> {
        match self {
            Self::Allowed { config, .. } => Some(config),
            Self::Denied(_) => None,
        }
    }

    pub(crate) fn add_evidence(&self, inputs: &[BeadInput], batch: &mut ActivityBatch) {
        match self {
            Self::Allowed { evidence, .. } => {
                for activity in batch.activities.values_mut() {
                    activity.evidence.push(evidence.clone());
                }
            }
            Self::Denied(evidence) => {
                for input in inputs {
                    let mut activity = empty_activity(input);
                    activity.evidence.push(evidence.clone());
                    batch
                        .activities
                        .insert((input.project.clone(), input.bead_id.clone()), activity);
                }
            }
        }
    }
}

fn evaluate(
    config: &OmoConfig,
    project: &Project,
    viewed: &[Project],
) -> anyhow::Result<WorkPolicy> {
    use anyhow::{ensure, Context};

    ensure!(
        project.database.is_none(),
        "a local project checkout is required"
    );
    let configured = config
        .work_policy_executable
        .as_deref()
        .context("no executable configured")?;
    ensure!(
        configured.is_absolute(),
        "configure an absolute executable path"
    );
    let root = project
        .path
        .canonicalize()
        .context("cannot resolve project root")?;
    let executable = configured
        .canonicalize()
        .context("cannot resolve executable")?;
    let parent = configured
        .parent()
        .context("executable has no parent directory")?
        .canonicalize()
        .context("cannot resolve executable parent")?;
    ensure!(
        executable.is_file()
            && !viewed
                .iter()
                .filter(|p| p.database.is_none())
                .filter_map(|p| p.path.canonicalize().ok())
                .chain(std::iter::once(root.clone()))
                .any(|path| executable.starts_with(&path) || parent.starts_with(path)),
        "configure an installed executable outside the viewed checkouts"
    );

    let reply = policy_reply(&executable, &root)?;
    ensure!(reply.version == 1, "unsupported evaluator response version");
    let source = display_field(&reply.source);
    ensure!(
        !source.trim().is_empty(),
        "evaluator decision source is missing"
    );
    let reason = reply.reason.as_deref().map(display_field);
    if reply.project.is_none() && matches!(reply.level, Level::Disabled) {
        return Ok(WorkPolicy::Denied(format!(
            "Work policy: disabled ({source}): {}",
            reason
                .as_deref()
                .unwrap_or("evaluator did not resolve a project")
        )));
    }
    ensure!(
        reply.project.as_deref().map(Path::as_os_str) == Some(root.as_os_str()),
        "evaluator project does not match the canonical configured root"
    );
    let level = match reply.level {
        Level::Disabled => {
            return Ok(WorkPolicy::Denied(format!(
                "Work policy: disabled ({source}): {}",
                reason
                    .as_deref()
                    .unwrap_or("native observations are disabled")
            )));
        }
        Level::Observation => "observation",
        Level::Management => "management",
        Level::Delegation => "delegation",
    };
    let task_directory = config
        .task_directory
        .canonicalize()
        .context("cannot resolve task_directory")?;
    ensure!(task_directory.is_dir(), "task_directory is not a directory");
    let evidence = match reason {
        Some(reason) => format!("Work policy: {level} ({source}): {reason}"),
        None => format!("Work policy: {level} ({source})"),
    };
    Ok(WorkPolicy::Allowed {
        config: Box::new(OmoConfig {
            task_directory,
            ..config.clone()
        }),
        evidence,
    })
}

fn display_field(text: &str) -> String {
    text.chars()
        .take(super::MAX_STRING)
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect()
}

fn policy_reply(executable: &Path, project: &Path) -> anyhow::Result<Reply> {
    use anyhow::{bail, ensure, Context};

    // Nonblocking reads keep the deadline even if a descendant holds stdout.
    let (mut stdout, writer) = UnixStream::pair().context("cannot open evaluator output")?;
    stdout
        .set_nonblocking(true)
        .context("cannot bound evaluator reads")?;
    let deadline = Instant::now() + POLICY_TIMEOUT;
    let path = env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into());
    let path = env::join_paths(env::split_paths(&path).filter(|dir| dir.is_absolute()))
        .context("cannot construct evaluator search path")?;
    let mut child = Command::new(executable)
        .arg("policy")
        .current_dir(project)
        .env_clear()
        .envs(
            [
                "HOME",
                "XDG_CONFIG_HOME",
                "USER",
                "LANG",
                "TMPDIR",
                "BDI_WORK_POLICY",
            ]
            .into_iter()
            .filter_map(|key| env::var_os(key).map(|value| (key, value))),
        )
        .env(
            "PATH",
            if path.is_empty() {
                "/usr/bin:/bin".into()
            } else {
                path
            },
        )
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .spawn()
        .context("cannot start evaluator")?;

    let mut output = Vec::with_capacity(MAX_REPLY_BYTES + 1);
    let result = (|| -> anyhow::Result<()> {
        loop {
            ensure!(Instant::now() < deadline, "evaluator timed out");
            let mut bounded =
                (&mut stdout).take(u64::try_from(MAX_REPLY_BYTES + 1 - output.len())?);
            let eof = match bounded.read_to_end(&mut output) {
                Ok(_) => true,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => false,
                Err(error) => return Err(error).context("cannot read evaluator output"),
            };
            ensure!(
                output.len() <= MAX_REPLY_BYTES,
                "evaluator output exceeded the byte limit"
            );
            if let Some(status) = child
                .try_wait()
                .context("cannot read evaluator exit status")?
            {
                ensure!(
                    status.success(),
                    "evaluator exited unsuccessfully ({status})"
                );
                if eof {
                    return Ok(());
                }
            }
            thread::sleep(
                Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    })();
    if let Err(error) = result {
        let killed = child.kill();
        // Waiting after a successful kill reaps the evaluator. A failed kill
        // cannot justify an unbounded wait.
        if let Err(cleanup) = killed.and_then(|()| child.wait()) {
            bail!("{error:#}; evaluator cleanup failed: {cleanup}");
        }
        return Err(error);
    }
    serde_json::from_slice(&output).context("invalid evaluator response")
}
