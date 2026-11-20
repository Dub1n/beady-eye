use super::{write_cache, Ground};
use crate::collect::omo::{ActivityState, ExecutionState, PresenceState, Reader};
use chrono::Utc;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;

#[test]
fn durable_admission_keeps_settlement_and_history_after_frame_shutdown() {
    let mut ground = Ground::new();
    ground.native["status"] = json!("completed");
    ground.write();
    let directory = ground.config.observation_directory.as_ref().unwrap();
    fs::remove_file(directory.join("frame-test.json")).unwrap();
    write_cache(&ground, ground.frame["admissions"][0].clone()).unwrap();

    let activity = Reader::new(ground.config.clone())
        .collect(std::slice::from_ref(&ground.input))
        .activities
        .into_values()
        .next()
        .unwrap();
    assert_eq!(activity.state, ActivityState::Finished);
    assert_eq!(activity.worker_execution, Some(ExecutionState::Inactive));
    assert_eq!(activity.worker_presence, Some(PresenceState::Unknown));
    assert_eq!(activity.child_session.as_deref(), Some("child-new"));
    assert_eq!(activity.worker_identity, None);
    let json = serde_json::to_value(&activity).unwrap();
    assert_eq!(json["child_session"], "child-new");
    assert_eq!(json["worker_presence"], "unknown");
    assert_eq!(json["worker_execution"], "inactive");

    let key = (activity.project.clone(), activity.bead_id.clone());
    let mut history = crate::collect::omo::history::History::default();
    history.observe(&BTreeMap::from([(key.clone(), activity)]), Utc::now());
    let retained = &history.beads()[&key].observations[0].activity;
    assert_eq!(retained.state, ActivityState::Finished);
    assert_eq!(retained.child_session.as_deref(), Some("child-new"));
    assert_eq!(retained.worker_presence, Some(PresenceState::Unknown));
}

#[test]
fn durable_admission_does_not_resurrect_removed_or_replaced_generations() {
    for case in ["deleted", "revoked", "replacement", "generation"] {
        let mut ground = Ground::new();
        ground.native["status"] = json!("completed");
        if case == "replacement" {
            ground.native["created_at"] = json!("2026-02-01T00:00:00Z");
        } else if case == "generation" {
            ground.native["notification"]["run_epoch"] = json!(8);
        }
        ground.write();
        let directory = ground.config.observation_directory.as_ref().unwrap();
        fs::remove_file(directory.join("frame-test.json")).unwrap();
        let mut admission = ground.frame["admissions"][0].clone();
        if case == "revoked" {
            admission["invalid"] = json!(true);
        }
        write_cache(&ground, admission).unwrap();
        if case == "deleted" {
            fs::remove_file(ground.config.task_directory.join("st_orchard.json")).unwrap();
        }

        let activity = Reader::new(ground.config.clone())
            .collect(std::slice::from_ref(&ground.input))
            .activities
            .into_values()
            .next()
            .unwrap();
        if case == "deleted" {
            assert_ne!(activity.state, ActivityState::Finished, "{case}");
            assert_eq!(activity.child_session, None, "{case}");
        } else {
            assert_eq!(activity.state, ActivityState::Conflict, "{case}");
        }
        assert_eq!(activity.presence_state(), PresenceState::Unknown, "{case}");
        assert_eq!(activity.worker_identity, None, "{case}");
    }
}

#[test]
fn durable_admission_never_promotes_missing_worker_to_live() {
    let ground = Ground::new();
    ground.write();
    let directory = ground.config.observation_directory.as_ref().unwrap();
    fs::remove_file(directory.join("frame-test.json")).unwrap();
    write_cache(&ground, ground.frame["admissions"][0].clone()).unwrap();

    let activity = Reader::new(ground.config.clone())
        .collect(std::slice::from_ref(&ground.input))
        .activities
        .into_values()
        .next()
        .unwrap();
    assert_eq!(activity.state, ActivityState::Unknown);
    assert_eq!(activity.worker_execution, Some(ExecutionState::Unknown));
    assert_eq!(activity.worker_presence, Some(PresenceState::Unknown));
    assert_eq!(activity.child_session.as_deref(), Some("child-new"));
    assert_eq!(activity.worker_identity, None);
}

#[test]
fn malformed_history_cache_does_not_discard_a_fresh_frame() {
    let ground = Ground::new();
    ground.write();
    let directory = ground.config.observation_directory.as_ref().unwrap();
    fs::write(directory.join("admission-malformed.json"), "{").unwrap();

    let activity = Reader::new(ground.config.clone())
        .collect(std::slice::from_ref(&ground.input))
        .activities
        .into_values()
        .next()
        .unwrap();
    assert_eq!(activity.presence_state(), PresenceState::LiveIdle);
    assert_eq!(
        activity.worker_identity.as_deref(),
        Some("host:instance-a:child-new:activity-a")
    );
}

#[test]
fn ambiguous_or_unique_workers_cannot_bypass_a_stale_durable_generation() {
    for case in ["ambiguous", "unique"] {
        let mut ground = Ground::new();
        ground.native["status"] = json!("completed");
        ground.frame["admissions"] = json!([]);
        if case == "ambiguous" {
            let worker = ground.frame["workers"][0].clone();
            ground.frame["workers"].as_array_mut().unwrap().push(worker);
        }
        ground.write();
        let stale = json!({
            "bead": "fruit-1",
            "attempt": "attempt-a",
            "toolCall": "call-a",
            "task": "st_orchard",
            "parent": "parent-a",
            "created": "2026-01-01T00:00:00Z",
            "initialChild": "child-old",
            "runEpoch": 6,
            "invalid": false
        });
        write_cache(&ground, stale).unwrap();

        let activity = Reader::new(ground.config.clone())
            .collect(std::slice::from_ref(&ground.input))
            .activities
            .into_values()
            .next()
            .unwrap();
        assert_eq!(activity.state, ActivityState::Conflict, "{case}");
        assert_eq!(activity.child_session, None, "{case}");
        assert_eq!(activity.presence_state(), PresenceState::Unknown, "{case}");
        assert_eq!(activity.worker_identity, None, "{case}");
    }
}
