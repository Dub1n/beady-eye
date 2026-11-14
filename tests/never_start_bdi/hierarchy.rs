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
