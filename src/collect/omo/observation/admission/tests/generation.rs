use super::{write_cache, Ground};
use crate::collect::omo::{ActivityState, ExecutionState, PresenceState, Reader};
use chrono::Utc;
use serde_json::json;
use std::fs;

#[test]
fn refresh_reuses_the_parent_cache_for_every_qualification() {
    let ground = Ground::new();
    ground.write();
    let directory = ground.config.observation_directory.as_ref().unwrap();
    fs::remove_file(directory.join("frame-test.json")).unwrap();
    write_cache(&ground, ground.frame["admissions"][0].clone()).unwrap();

    let mut observations = super::super::super::Observations::default();
    observations.refresh(&ground.config);
    fs::remove_file(
        super::super::super::admission::cache_path(
            directory,
            "orchard",
            &ground.config.task_directory,
            "parent-a",
        )
        .unwrap(),
    )
    .unwrap();

    let receipt = &ground.input.fields["metadata"]["qrclipDispatch"];
    for _ in 0..2 {
        let qualified = observations.qualify(
            &ground.config,
            &ground.input,
            receipt,
            &ground.native,
            Utc::now(),
        );
        assert_eq!(qualified.unwrap().session.as_deref(), Some("child-new"));
    }
}

#[test]
fn legacy_live_frame_uses_its_current_worker_epoch() {
    let mut ground = Ground::new();
    ground.frame["admissions"][0]
        .as_object_mut()
        .unwrap()
        .remove("runEpoch");
    let activity = ground.read();
    assert_eq!(activity.child_session.as_deref(), Some("child-new"));
    assert_eq!(activity.worker_presence, Some(PresenceState::LiveIdle));
    assert_eq!(
        activity.worker_identity.as_deref(),
        Some("host:instance-a:child-new:activity-a")
    );
}

#[test]
fn legacy_generationless_terminal_cache_remains_unknown() {
    let mut ground = Ground::new();
    ground.native["status"] = json!("completed");
    ground.write();
    let directory = ground.config.observation_directory.as_ref().unwrap();
    fs::remove_file(directory.join("frame-test.json")).unwrap();
    let mut admission = ground.frame["admissions"][0].clone();
    admission.as_object_mut().unwrap().remove("runEpoch");
    write_cache(&ground, admission).unwrap();

    let activity = Reader::new(ground.config.clone())
        .collect(std::slice::from_ref(&ground.input))
        .activities
        .into_values()
        .next()
        .unwrap();
    assert_eq!(activity.state, ActivityState::Unknown);
    assert_eq!(activity.worker_execution, Some(ExecutionState::Unknown));
    assert_eq!(activity.worker_presence, Some(PresenceState::Unknown));
    assert_eq!(activity.child_session, None);
    assert_eq!(activity.worker_identity, None);
    assert!(activity
        .evidence
        .iter()
        .any(|item| item.contains("durable admission lacks the current task generation")));
}
