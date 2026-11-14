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
        {"id":"ark-root.1","title":"Check gateway","parent":"ark-root", "dependencies":[{"depends_on_id":"ark-root","type":"parent-child"}], "status":"in_progress","priority":2,"issue_type":"task","metadata":{"qrclipWork":{"attempt":{"id":"invented-attempt","coordinator":"invented-coordinator","mode":"delegate"}},"qrclipDispatch":{"attemptId":"invented-attempt","taskId":"st_invented","childSession":"invented-child","nativeStatus":"running"}}},
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
    let detail = beady_eye::view::show::said(child, &[], None, 120, 80, &|_| false);
    let text = detail
        .rows
        .iter()
        .flat_map(|row| row.iter().map(|s| s.content.as_ref()))
        .collect::<Vec<_>>()
        .join(" ");
    assert!(text.contains("st_invented") && text.contains("invented-attempt"));
    assert!(text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .contains("Worker finished; this does not establish outcome or acceptance"));
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
    changed["updated_at"] = Utc::now().to_rfc3339().into();
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
    let evidence = &child.activity.as_ref().unwrap().evidence;
    assert!(evidence
        .iter()
        .any(|e| e.contains("observed worker history") && e.contains("Finished")));
    assert!(evidence
        .iter()
        .any(|e| e.contains("observed worker history") && e.contains("Failed")));
}

#[test]
fn native_live_owners_join_before_snapshot_build_and_link_bead_preview_without_exclusive_claims() {
    use beady_eye::collect::agents::testing::Fake as Agents;
    use beady_eye::model::{
        join::JoinSource,
        snapshot::Counts,
        types::{AgentSession, Pane, PaneStatus},
    };
    let ground = Ground(std::env::temp_dir().join(format!(
        "bdi-live-native-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    std::fs::create_dir_all(&ground.0).unwrap();
    let mut cfg =
        Config::from_toml("[[projects]]\nname='arkham'\npath='/srv/work/arkham'\n[[projects]]\nname='dunwich'\npath='/srv/work/dunwich'\n").unwrap();
    cfg.omo.insert(
        "arkham".into(),
        OmoConfig {
            task_directory: ground.0.join("tasks"),
            session_directory: Some(ground.0.clone()),
            ..OmoConfig::default()
        },
    );
    std::fs::write(
        ground.0.join("invented_owner-a.jsonl"),
        format!(
            "{}\n{}\n",
            serde_json::json!({"type":"session","version":3,"id":"owner-a"}),
            serde_json::json!({"type":"model_change","provider":"invented","modelId":"model-a"})
        ),
    )
    .unwrap();
    let source = serde_json::json!([
        {"id":"ark-1","title":"Gateway","status":"in_progress","dependencies":[{"depends_on_id":"dunwich:dun-1","type":"blocks"}],"metadata":{"qrclipWork":{"attempt":{"id":"attempt-a","coordinator":"owner-a","mode":"direct"}}}},
        {"id":"ark-2","title":"Search","status":"in_progress","metadata":{"qrclipWork":{"attempt":{"id":"attempt-b","coordinator":"owner-a","mode":"delegate"}}}}
    ]);
    let trackers = Fakes::default().with(
        "arkham",
        Fake::holding(parse_beads(&source.to_string()).unwrap()),
    );
    let trackers = trackers.with(
        "dunwich",
        Fake::holding(
            parse_beads(r#"[{"id":"dun-1","title":"Shared contract","status":"closed"}]"#).unwrap(),
        ),
    );
    let mut pane = Pane::answered(
        "default".into(),
        "w:p1".into(),
        "/srv/work/arkham".into(),
        PaneStatus::Working,
    );
    pane.agent = Some("pi".into());
    pane.agent_session = Some(AgentSession {
        agent: "pi".into(),
        kind: "id".into(),
        source: "invented".into(),
        value: "owner-a".into(),
    });
    let agents = Agents::holding(vec![pane]);
    let mut collection = beady_eye::app::Collection::default();
    let snapshot = collection.collect(
        &cfg,
        &agents,
        &trackers,
        &beady_eye::app::Wanted::Everything,
        Filter::CurrentWork,
        Utc::now(),
    );
    let nodes: Vec<_> = snapshot
        .collected
        .iter()
        .flat_map(|tree| &tree.beads)
        .filter(|node| node.project == "arkham")
        .collect();
    assert_eq!(nodes.len(), 2);
    assert!(snapshot.unattributed.is_empty());
    assert_eq!(Counts::over(nodes.iter().copied()).live_agents, 1);
    let mut forest = beady_eye::view::forest::flatten(snapshot.clone());
    for node in nodes {
        assert_eq!(
            node.activity.as_ref().unwrap().state,
            ActivityState::Unknown
        );
        let agent = node.agent.as_ref().unwrap();
        assert_eq!(agent.pane.id, "w:p1");
        assert_eq!(
            agent.source,
            if node.id == "ark-1" {
                JoinSource::NativeOwner
            } else {
                JoinSource::NativeCoordinator
            }
        );
        if node.id == "ark-2" {
            let mut delegated = (*node).clone();
            let activity = delegated.activity.as_mut().unwrap();
            activity.coordinator_model = Some("invented/model-a".into());
            let mut worker = activity.clone();
            worker.effective_model = Some("invented/worker-model".into());
            worker.workers.clear();
            activity.effective_model = worker.effective_model.clone();
            activity.workers = vec![worker];
            let delegated_row = beady_eye::view::row::cells(&delegated, None, None, None);
            assert_eq!(
                delegated_row.activity_model.as_deref(),
                Some("worker worker-model / model-a")
            );
            assert_eq!(
                delegated_row.live_agent_state.as_deref(),
                Some("coord live · ?")
            );
        }
        let row = beady_eye::view::row::cells(node, None, None, None);
        assert_eq!(row.activity_model.as_deref(), Some("model-a"));
        assert_eq!(
            row.live_agent_state.as_deref(),
            Some(if node.id == "ark-1" {
                "owner live · ?"
            } else {
                "coord live · ?"
            })
        );
        forest.go_to(&node.key());
        assert_eq!(
            beady_eye::view::tail::target(&forest).pane(),
            Some(&agent.pane)
        );
        let detail = beady_eye::view::show::said(node, &[], None, 80, 40, &|_| false);
        let text = detail
            .rows
            .iter()
            .flat_map(|r| r.iter().map(|s| s.content.as_ref()))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            text.contains("Pane: default/w:p1") && text.contains("Agent session: owner-a"),
            "{text}"
        );
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            text.contains("Execution unknown: no bead-specific worker task is linked"),
            "{text}"
        );
    }
    // A missing terminal on the next collection must remove liveness, not cache it.
    let next = collection.redraw(&cfg, &Unasked, &trackers, Filter::CurrentWork, Utc::now());
    assert!(next
        .collected
        .iter()
        .flat_map(|tree| &tree.beads)
        .all(|node| node.agent.is_none()));
}
