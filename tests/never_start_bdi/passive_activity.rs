//! Invented source records through collection, derived activity and row rendering.
use beady_eye::collect::tracker::testing::{Fake, Fakes};
use beady_eye::collect::{
    agents::Unasked,
    bd::parse_beads,
    omo::{ActivityState, OmoConfig},
};
use beady_eye::config::Config;
use beady_eye::model::snapshot::Filter;
use chrono::Utc;
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Ground(std::path::PathBuf);
impl Drop for Ground {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn native_completion_refines_open_work_without_closing_it_or_claiming_a_pane() {
    let ground = Ground(std::env::temp_dir().join(format!(
        "bdi-invented-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    std::fs::create_dir_all(&ground.0).unwrap();
    let mut cfg =
        Config::from_toml("[[projects]]\nname='arkham'\npath='/srv/work/arkham'\n").unwrap();
    cfg.omo.insert(
        "arkham".into(),
        OmoConfig {
            task_directory: ground.0.clone(),
            ..OmoConfig::default()
        },
    );
    let record = serde_json::json!({"task_id":"st_invented", "status":"completed", "parent_session_id":"invented-coordinator", "child_session_id":"invented-child", "name":"check-gateway", "agent_type":"reviewer", "effective_model":{"model_id":"gpt-6.1-sol","provider":"invented"}, "updated_at":Utc::now().to_rfc3339()});
    let path = ground.0.join("st_invented.json");
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let source = serde_json::json!([
        {"id":"ark-root","title":"Gateway","status":"in_progress","priority":1,"issue_type":"epic"},
        {"id":"ark-root.1","title":"Check gateway","parent":"ark-root", "dependencies":[{"depends_on_id":"ark-root","type":"parent-child"}], "status":"in_progress","priority":2,"issue_type":"task","metadata":{"qrclipWork":{"attempt":{"id":"invented-attempt","coordinator":"invented-coordinator","mode":"delegate"}},"qrclipDispatch":{"attemptId":"invented-attempt","taskId":"st_invented","nativeStatus":"running"}}},
        {"id":"ark-old","title":"Earlier work","status":"closed","priority":2,"issue_type":"task"}
    ]);
    let trackers = Fakes::default().with(
        "arkham",
        Fake::holding(parse_beads(&source.to_string()).unwrap()),
    );
    let mut collection = beady_eye::app::Collection::default();
    let snap = collection.collect(
        &cfg,
        &Unasked,
        &trackers,
        &beady_eye::app::Wanted::Everything,
        Filter::CurrentWork,
        Utc::now(),
    );
    let child = snap
        .collected
        .iter()
        .flat_map(|t| &t.beads)
        .find(|n| n.id == "ark-root.1")
        .unwrap();
    assert_eq!(child.status, beady_eye::model::types::Status::InProgress);
    assert_eq!(
        child.activity.as_ref().unwrap().state,
        ActivityState::Finished
    );
    assert_eq!(child.activity.as_ref().unwrap().model_label(), Some("Sol"));
    assert!(
        child.agent.is_none(),
        "a background task does not fabricate a pane claim"
    );
    assert!(
        !child.anomalies.iter().any(|a| matches!(
            a,
            beady_eye::model::anomaly::Anomaly::OrphanClaim { refused: None }
        )),
        "native workers without panes are not reported as orphan claims"
    );
    assert!(!snap.trees.iter().any(|t| t.root == "ark-old"));
    let mut history = snap.clone();
    history.refilter(Filter::History);
    assert!(history.trees.iter().any(|t| t.root == "ark-old"));
    let detail = beady_eye::view::show::said(child, &[], None, 30, 20, &|_| false);
    let text = detail
        .rows
        .iter()
        .flat_map(|row| row.iter().map(|s| s.content.as_ref()))
        .collect::<Vec<_>>()
        .join(" ");
    assert!(text.contains("st_invented") && text.contains("invented-attempt"));
    // Partial writes retain explicitly qualified last-good terminal evidence.
    std::fs::write(&path, b"{").unwrap();
    let partial = collection.redraw(&cfg, &Unasked, &trackers, Filter::CurrentWork, Utc::now());
    let previous = partial
        .collected
        .iter()
        .flat_map(|t| &t.beads)
        .find(|n| n.id == "ark-root.1")
        .unwrap()
        .activity
        .as_ref()
        .unwrap();
    assert_eq!(previous.state, ActivityState::Finished);
    assert_eq!(previous.fresh, Some(false));
    assert!(previous
        .evidence
        .iter()
        .any(|s| s.contains("last") || s.contains("invalid")));
    // A later snapshot re-reads native status even when Beads data is identical.
    let mut changed = record.clone();
    changed["status"] = "error".into();
    std::fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
    let next = collection.redraw(&cfg, &Unasked, &trackers, Filter::CurrentWork, Utc::now());
    let child = next
        .collected
        .iter()
        .flat_map(|t| &t.beads)
        .find(|n| n.id == "ark-root.1")
        .unwrap();
    assert_eq!(
        child.activity.as_ref().unwrap().state,
        ActivityState::Failed
    );
}
