//! Ownership and dependency navigation through the actual terminal event loop.
mod terminal;
use terminal::driver::{Driven, GIVING_UP};
use terminal::shims::ShimmedTracker;
use terminal::{a_home_naming_one_project_settled, ENTER_ALTERNATE_SCREEN};

#[test]
fn graph_toggle_preserves_dependencies_and_space_and_control_space_have_distinct_roles() {
    let home = a_home_naming_one_project_settled(
        "ownership-keys",
        "[row]\ncompact=true\nindent=2\nascii=true\n",
    );
    let tracker = ShimmedTracker::beside(&home);
    tracker.holds(&serde_json::json!([
        {"id":"ark-root","title":"Gateway","status":"in_progress","priority":1,"issue_type":"epic"},
        {"id":"ark-shared","title":"Shared worker","status":"in_progress","priority":2,"issue_type":"task","dependencies":[{"depends_on_id":"ark-root","type":"parent-child"}]},
        {"id":"ark-review","title":"Review","status":"open","priority":2,"issue_type":"task","dependencies":[{"depends_on_id":"ark-root","type":"parent-child"},{"depends_on_id":"ark-shared","type":"blocks"}]},
        {"id":"ark-release","title":"Release","status":"open","priority":2,"issue_type":"task","dependencies":[{"depends_on_id":"ark-shared","type":"blocks"}]}
    ]).to_string());
    let mut app = Driven::bdi(26, 80, home, &tracker.environment());
    app.read_until(ENTER_ALTERNATE_SCREEN, GIVING_UP);
    app.read_until(b"Release", GIVING_UP);
    let expand = app.send(b"E");
    app.answer_to(expand, GIVING_UP);
    let repaint = app.resize(27, 80);
    let screen = app.answer_to(repaint, GIVING_UP);
    let tree = terminal::rows_drawn(&screen);
    assert_eq!(
        tree.iter()
            .filter(|row| row.contains("Shared worker"))
            .count(),
        1,
        "{tree:?}"
    );
    assert!(tree.iter().any(|row| row.contains("Release")));

    let graph = app.send(b"bE");
    app.answer_to(graph, GIVING_UP);
    let repaint = app.resize(26, 80);
    let screen = app.answer_to(repaint, GIVING_UP);
    let graph = terminal::rows_drawn(&screen);
    assert!(
        graph
            .iter()
            .filter(|row| row.contains("Shared worker"))
            .count()
            >= 2,
        "{graph:?}"
    );
    let tree = app.send(b"b");
    app.answer_to(tree, GIVING_UP);
    // Choose the first bead, regardless of the initial asynchronous selection.
    let select = app.send(b"gj");
    app.answer_to(select, GIVING_UP);
    let details = app.send(b" ");
    app.answer_to(details, GIVING_UP);
    let repaint = app.resize(27, 80);
    let screen = app.answer_to(repaint, GIVING_UP);
    assert!(
        terminal::window_over(&screen).is_some(),
        "Space opens details"
    );
    let back = app.send(b"\x1b");
    app.answer_to(back, GIVING_UP);
    let root = app.send(b"\0");
    app.answer_to(root, GIVING_UP);
    let repaint = app.resize(26, 80);
    let screen = app.answer_to(repaint, GIVING_UP);
    assert!(
        terminal::window_over(&screen).is_none(),
        "Ctrl+Space does not open details"
    );
    let rooted = terminal::rows_drawn(&screen);
    assert!(
        rooted.iter().any(|row| row.contains("Gateway")),
        "{rooted:?}"
    );
    assert!(
        !rooted.iter().any(|row| row.contains("Release")),
        "Ctrl+Space/NUL scopes to the selected root: {rooted:?}"
    );
    app.send(b"q");
}
