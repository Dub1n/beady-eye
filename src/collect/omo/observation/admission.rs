use super::super::{read_bounded, safe_id, MAX_RECORD_BYTES};
use super::Scope;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Admission {
    pub(super) bead: String,
    pub(super) attempt: String,
    pub(super) tool_call: String,
    pub(super) task: String,
    pub(super) parent: String,
    pub(super) created: String,
    pub(super) initial_child: Option<String>,
    #[serde(default)]
    pub(super) run_epoch: Option<u64>,
    pub(super) invalid: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdmissionCache {
    version: u32,
    scope: Scope,
    parent: String,
    admissions: Vec<Admission>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheScope<'a> {
    project: &'a str,
    task_directory: &'a Path,
}

pub(super) fn cache_path(
    directory: &Path,
    project: &str,
    task_directory: &Path,
    parent: &str,
) -> Result<PathBuf, ()> {
    let scope = CacheScope {
        project,
        task_directory,
    };
    let encoded = serde_json::to_vec(&(scope, parent)).map_err(|_| ())?;
    let digest = Sha256::digest(encoded);
    let name = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(directory.join(format!("admission-{name}.json")))
}

pub(super) struct Stored {
    pub(super) scope: Scope,
    pub(super) parent: String,
    pub(super) admissions: Vec<Admission>,
    pub(super) bytes: u64,
}

pub(super) fn read_cache(path: &Path) -> Result<Option<Stored>, ()> {
    let Some((bytes, _)) = read_bounded(path, MAX_RECORD_BYTES).map_err(|_| ())? else {
        return Ok(None);
    };
    let cache: AdmissionCache = serde_json::from_slice(&bytes).map_err(|_| ())?;
    let Some(directory) = path.parent() else {
        return Err(());
    };
    let expected = cache_path(
        directory,
        &cache.scope.project,
        &cache.scope.task_directory,
        &cache.parent,
    )?;
    if cache.version != 1
        || !safe_id(&cache.parent)
        || cache.admissions.len() > 128
        || expected != path
    {
        return Err(());
    }
    Ok(Some(Stored {
        scope: cache.scope,
        parent: cache.parent,
        admissions: cache.admissions,
        bytes: u64::try_from(bytes.len()).map_err(|_| ())?,
    }))
}

impl Admission {
    pub(super) fn same_dispatch(&self, other: &Self) -> bool {
        self.bead == other.bead
            && self.attempt == other.attempt
            && self.tool_call == other.tool_call
            && self.task == other.task
            && self.parent == other.parent
            && self.created == other.created
            && self.initial_child == other.initial_child
    }
}

#[cfg(test)]
mod tests;
