//! Invented ownership, shared blockers and malformed parents through collection.
use beady_eye::app::{Collection, Wanted};
use beady_eye::collect::{
    agents::Unasked,
    bd::parse_beads,
    tracker::testing::{Fake, Fakes},
};
use beady_eye::config::Config;
use beady_eye::model::snapshot::{Filter, Snapshot, TrackerFailure, TrackerState, Tree};
use beady_eye::view::{forest, Action};
use chrono::Utc;
use std::collections::BTreeMap;
use std::sync::Arc;

fn source() -> Snapshot {
    let cfg = Config::from_toml("[[projects]]\nname='arkham'\npath='/srv/invented/arkham'\n[[projects]]\nname='dunwich'\npath='/srv/invented/dunwich'\n").unwrap();
    let beads = serde_json::json!([
        {"id":"ark-1","title":"Gateway","status":"open"},
        {"id":"ark-1.1","title":"Refunds","status":"in_progress","dependencies":[{"depends_on_id":"ark-1","type":"parent-child"}]},
        {"id":"ark-1.2","title":"Acceptance","status":"open","dependencies":[{"depends_on_id":"ark-1","type":"parent-child"},{"depends_on_id":"ark-1.1","type":"blocks"}]},
        {"id":"ark-2","title":"Release","status":"open","dependencies":[{"depends_on_id":"ark-1.2","type":"blocks"}]},
        {"id":"ark-3","title":"Lost parent","status":"open","dependencies":[{"depends_on_id":"ark-missing","type":"parent-child"}]},
        {"id":"ark-4","title":"Cycle A","status":"open","dependencies":[{"depends_on_id":"ark-5","type":"parent-child"}]},
        {"id":"ark-5","title":"Cycle B","status":"open","dependencies":[{"depends_on_id":"ark-4","type":"parent-child"}]},
        {"id":"ark-old","title":"Old archive","status":"closed"}
    ]);
    let other = serde_json::json!([
        {"id":"ark-1","title":"Other gateway","status":"open"},
        {"id":"ark-1.1","title":"Other refund","status":"open","dependencies":[{"depends_on_id":"ark-1","type":"parent-child"}]}
    ]);
    let trackers = Fakes::default()
        .with(
            "arkham",
            Fake::holding(parse_beads(&beads.to_string()).unwrap()),
        )
        .with(
            "dunwich",
            Fake::holding(parse_beads(&other.to_string()).unwrap()),
        );
    Collection::default().collect(
        &cfg,
        &Unasked,
        &trackers,
        &Wanted::Everything,
        Filter::All,
        Utc::now(),
    )
}

#[test]
fn ownership_has_one_copy_per_project_and_preserves_relations_and_unread_roots() {
    let mut source = source();
    source.collected.push(Arc::new(Tree::unread(
        "arkham",
        "ark-unread",
        TrackerState::Unreachable(TrackerFailure::Unavailable),
    )));
    let before = source.clone();
    let tree = source.hierarchy();
    let original: BTreeMap<_, _> = source
        .collected
        .iter()
        .flat_map(|t| &t.beads)
        .map(|b| (b.key(), b))
        .collect();
    let mut seen = BTreeMap::new();
    for root in &tree.collected {
        for bead in &root.beads {
            assert!(
                seen.insert(bead.key(), bead).is_none(),
                "duplicate {}",
                bead.id
            );
            assert_eq!(
                original[&bead.key()],
                bead,
                "all evidence and dependencies stay intact"
            );
        }
    }
    assert_eq!(seen.len(), 10);
    assert!(
        tree.collected.iter().any(|t| t.root == "ark-3"),
        "missing parents leave work reachable"
    );
    assert!(
        tree.collected.iter().any(|t| !t.cycles.is_empty()),
        "cycle remains qualified"
    );
    assert!(tree.collected.iter().any(|t| t.root == "ark-unread"));
    let gateway = tree
        .collected
        .iter()
        .find(|t| t.project == "arkham" && t.root == "ark-1")
        .unwrap();
    assert_eq!(
        gateway.counts.total, 3,
        "blocking dependencies do not inflate ownership progress"
    );
    assert_eq!(
        source, before,
        "projection never changes the acquired graph"
    );
}

#[test]
fn dependency_toggle_and_ready_list_keep_the_graph_while_home_restores_the_tree() {
    let source = source();
    let source_copies: usize = source.trees.iter().map(|t| t.beads.len()).sum();
    let mut viewer = forest::flatten(source.clone());
    let ownership: usize = viewer
        .snapshot()
        .collected
        .iter()
        .map(|t| t.beads.len())
        .sum();
    assert_eq!(ownership, 10);
    viewer.apply(Action::ToggleDependencies);
    assert_eq!(viewer.snapshot().collected, source.collected);
    assert!(
        source_copies > ownership,
        "invented graph really shares work across roots"
    );
    viewer.apply(Action::ToggleDependencies);
    assert_eq!(
        viewer
            .snapshot()
            .collected
            .iter()
            .map(|t| t.beads.len())
            .sum::<usize>(),
        ownership
    );
    viewer.apply(Action::ToggleReadyList);
    assert_eq!(viewer.snapshot().collected, source.collected);
    viewer.apply(Action::Home);
    assert_eq!(viewer.snapshot().filter, Filter::CurrentWork);
    assert!(viewer.snapshot().trees.iter().all(|t| t.root != "ark-old"));
    viewer.refresh(source);
    assert_eq!(
        viewer
            .snapshot()
            .collected
            .iter()
            .map(|t| t.beads.len())
            .sum::<usize>(),
        ownership
    );
}

#[test]
fn rooting_from_the_ready_view_enters_the_selected_ownership_subtree() {
    let mut source = source();
    for tree in &mut source.collected {
        for bead in &mut Arc::make_mut(tree).beads {
            bead.ready = bead.project == "arkham" && bead.id == "ark-1.1";
        }
    }
    source.refilter(Filter::All);
    let key = beady_eye::model::join::BeadKey {
        project: "arkham".into(),
        id: "ark-1.1".into(),
    };
    let mut viewer = forest::flatten(source);
    viewer.apply(Action::ToggleReadyList);
    assert!(!viewer.footer_state().starts_with("Tree"));
    assert!(viewer.go_to(&key));
    viewer.apply(Action::FocusForest);
    assert!(viewer.footer_state().starts_with("Tree"));
    assert_eq!(viewer.focused_on(), [key].into());
}

#[test]
fn setting_root_inside_a_focused_tree_is_idempotent_and_survives_view_switches() {
    let mut viewer = forest::flatten(source());
    let root = beady_eye::model::join::BeadKey {
        project: "arkham".into(),
        id: "ark-1".into(),
    };
    let child = beady_eye::model::join::BeadKey {
        project: "arkham".into(),
        id: "ark-1.1".into(),
    };
    assert!(viewer.go_to(&root));
    viewer.apply(Action::RootSelected);
    assert!(viewer.go_to(&child));
    viewer.apply(Action::RootSelected);
    assert_eq!(viewer.focused_on(), [child.clone()].into());
    viewer.apply(Action::RootSelected);
    assert_eq!(viewer.focused_on(), [child.clone()].into());
    viewer.apply(Action::ToggleDependencies);
    assert_eq!(viewer.focused_on(), [child.clone()].into());
    viewer.apply(Action::ToggleDependencies);
    assert_eq!(viewer.focused_on(), [child].into());
}

#[test]
fn parent_root_reveals_one_level_without_moving_the_selected_bead() {
    let mut viewer = forest::flatten(source());
    let parent = beady_eye::model::join::BeadKey {
        project: "arkham".into(),
        id: "ark-1".into(),
    };
    let child = beady_eye::model::join::BeadKey {
        project: "arkham".into(),
        id: "ark-1.1".into(),
    };
    assert!(
        !viewer.apply(Action::RootUp),
        "home has no enclosing focused root"
    );
    assert!(viewer.go_to(&child));
    viewer.apply(Action::RootSelected);
    assert!(viewer.apply(Action::RootUp));
    assert_eq!(viewer.focused_on(), [parent].into());
    assert_eq!(viewer.lines()[viewer.selected_line()].bead(), Some(&child));
    assert!(viewer.apply(Action::RootUp));
    assert!(viewer.focused_on().is_empty());
    assert_eq!(viewer.lines()[viewer.selected_line()].bead(), Some(&child));
}

#[test]
fn parent_root_requests_ancestry_after_a_collection_only_retained_the_focused_subtree() {
    let complete = source();
    let parent = beady_eye::model::join::BeadKey {
        project: "arkham".into(),
        id: "ark-1".into(),
    };
    let child = beady_eye::model::join::BeadKey {
        project: "arkham".into(),
        id: "ark-1.1".into(),
    };
    let node = complete
        .collected
        .iter()
        .flat_map(|tree| &tree.beads)
        .find(|node| node.key() == child)
        .unwrap()
        .clone();
    let mut partial = complete.clone();
    partial.collected = vec![Arc::new(Tree {
        project: child.project.clone(),
        root: child.id.clone(),
        title: node.title.clone(),
        counts: beady_eye::model::snapshot::Counts::over(std::slice::from_ref(&node)),
        tracker: TrackerState::Ok,
        beads: vec![node],
        children: vec![vec![]],
        orphaned_dependencies: vec![],
        cycles: vec![],
    })];
    partial.refilter(Filter::All);
    let mut viewer = forest::flatten(complete.clone());
    assert!(viewer.go_to(&child));
    viewer.apply(Action::RootSelected);
    viewer.refresh(partial);
    assert_eq!(viewer.focused_on(), [child.clone()].into());
    assert_eq!(
        viewer.lines()[viewer.selected_line()].bead(),
        Some(&child),
        "a focused refresh keeps the bead selected"
    );
    viewer.apply(Action::RootUp);
    assert_eq!(
        viewer.focused_on(),
        [parent.clone()].into(),
        "request the parent that the next collection must build"
    );
    viewer.refresh(complete);
    assert_eq!(viewer.focused_on(), [parent].into());
    assert_eq!(viewer.lines()[viewer.selected_line()].bead(), Some(&child));
}

#[test]
fn live_filter_keeps_ancestors_and_source_relations_and_clears_without_data_loss() {
    let original = source();
    let mut view = forest::flatten(original.clone());
    view.apply(Action::ExpandForest);
    view.filter_search("~ refunds");
    let shown: Vec<_> = view
        .lines()
        .viewport(0, view.lines().len())
        .filter_map(|(_, line)| line.bead().map(|key| key.id.clone()))
        .collect();
    assert!(
        shown.contains(&"ark-1".to_string()),
        "ancestor context: {shown:?}"
    );
    assert!(shown.contains(&"ark-1.1".to_string()), "match: {shown:?}");
    assert!(!shown.contains(&"ark-2".to_string()), "nonmatch: {shown:?}");
    assert_eq!(
        view.snapshot().collected.len(),
        original.hierarchy().collected.len()
    );
    view.filter_search("");
    let shown: Vec<_> = view
        .lines()
        .viewport(0, view.lines().len())
        .filter_map(|(_, line)| line.bead().map(|key| key.id.clone()))
        .collect();
    assert!(shown.contains(&"ark-2".to_string()), "cleared: {shown:?}");
}

#[test]
fn regex_exclusions_apply_to_every_status_and_reject_invalid_configuration() {
    let config = "[[projects]]\nname='arkham'\npath='/srv/invented/arkham'\n[hide_titles]\narkham='^Disposable'\n";
    let cfg = Config::from_toml(config).unwrap();
    assert!(Config::from_toml(&config.replace("^Disposable", "[")).is_err());
    assert!(Config::from_toml(&config.replace("^Disposable", "")).is_err());
    let rows = serde_json::json!([
        {"id":"ark-0","title":"Container","status":"open"},
        {"id":"ark-1","title":"Disposable open probe","status":"open","dependencies":[{"depends_on_id":"ark-0","type":"parent-child"}]},
        {"id":"ark-2","title":"Disposable old probe","status":"closed"},
        {"id":"ark-3","title":"Keep disposable product","status":"in_progress"}
    ]);
    let trackers = Fakes::default().with(
        "arkham",
        Fake::holding(parse_beads(&rows.to_string()).unwrap()),
    );
    let snapshot = Collection::default().collect(
        &cfg,
        &Unasked,
        &trackers,
        &Wanted::Everything,
        Filter::All,
        Utc::now(),
    );
    let mut view = forest::flatten(snapshot);
    view.apply(Action::ExpandForest);
    for completed in [false, true] {
        if completed {
            view.apply(Action::ToggleCompleted);
        }
        let shown: Vec<_> = view
            .lines()
            .viewport(0, view.lines().len())
            .filter_map(|(_, line)| line.bead().map(|key| key.id.clone()))
            .collect();
        assert!(!shown.contains(&"ark-1".to_string()), "{shown:?}");
        assert!(!shown.contains(&"ark-2".to_string()), "{shown:?}");
        assert!(shown.contains(&"ark-3".to_string()), "{shown:?}");
    }
    view.filter_search("Disposable open");
    assert!(
        !view
            .lines()
            .viewport(0, view.lines().len())
            .any(|(_, line)| line.bead().is_some()),
        "excluded matches must not leave unrelated ancestors"
    );
    view.filter_search("");
    view.apply(Action::ToggleFixtures);
    view.apply(Action::ExpandForest);
    assert!(view
        .lines()
        .viewport(0, view.lines().len())
        .any(|(_, line)| line.bead().is_some_and(|key| key.id == "ark-1")));
}
