use super::super::tests::Ground;
use super::cache_path;
use serde_json::{json, Value};
use std::fs;

mod generation;
mod settlement;

pub(super) fn write_cache(ground: &Ground, admission: Value) -> std::io::Result<()> {
    let directory = ground
        .config
        .observation_directory
        .as_ref()
        .ok_or(std::io::ErrorKind::NotFound)?;
    let path = cache_path(
        directory,
        "orchard",
        &ground.config.task_directory,
        "parent-a",
    )
    .map_err(|_| std::io::ErrorKind::InvalidInput)?;
    fs::write(
        path,
        json!({
            "version": 1,
            "scope": {
                "project": "orchard",
                "taskDirectory": ground.config.task_directory
            },
            "parent": "parent-a",
            "admissions": [admission]
        })
        .to_string(),
    )
}
