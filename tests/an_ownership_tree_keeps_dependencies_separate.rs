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
    // Enter a lower root, then reveal exactly one containing level.
    let child = app.send(b"\x1b[C\0");
    app.answer_to(child, GIVING_UP);
    let repaint = app.resize(27, 80);
    let screen = app.answer_to(repaint, GIVING_UP);
    let lower = terminal::rows_drawn(&screen);
    assert!(
        !lower.iter().any(|row| row.contains("Gateway")),
        "{lower:?}"
    );
    let up = app.send(b"\x7f");
    app.answer_to(up, GIVING_UP);
    app.read_until(b"Gateway", GIVING_UP);
    let repaint = app.resize(26, 80);
    let screen = app.answer_to(repaint, GIVING_UP);
    let parent = terminal::rows_drawn(&screen);
    assert!(
        parent.iter().any(|row| row.contains("Gateway")),
        "{parent:?}"
    );
    assert!(
        !parent.iter().any(|row| row.contains("Release")),
        "Backspace reveals one level, not the entire forest: {parent:?}"
    );
    let details = app.send(b" ");
    app.answer_to(details, GIVING_UP);
    let repaint = app.resize(27, 80);
    let screen = app.answer_to(repaint, GIVING_UP);
    assert!(terminal::window_over(&screen).is_some());
    let home = app.send(b"H");
    app.answer_to(home, GIVING_UP);
    let repaint = app.resize(26, 80);
    let screen = app.answer_to(repaint, GIVING_UP);
    assert!(
        terminal::window_over(&screen).is_none(),
        "H leaves details for Home"
    );
    assert!(
        terminal::rows_drawn(&screen)
            .iter()
            .any(|row| row.contains("Release")),
        "H restores the default forest"
    );
    app.send(b"q");
}

#[test]
fn filtering_and_arrow_navigation_keep_the_prompt_editable_and_help_scrolls() {
    let home = a_home_naming_one_project_settled(
        "filter-keys",
        "[row]\nsearch_mode='filter'\npreview_min_height=0\n",
    );
    let tracker = ShimmedTracker::beside(&home);
    tracker.holds(&serde_json::json!([
        {"id":"ark-root","title":"Gateway","status":"open"},
        {"id":"ark-1","title":"Refund alpha","status":"blocked","dependencies":[{"depends_on_id":"ark-root","type":"parent-child"}]},
        {"id":"ark-2","title":"Refund beta","status":"in_progress","dependencies":[{"depends_on_id":"ark-root","type":"parent-child"}]},
        {"id":"ark-3","title":"Other work","status":"open","dependencies":[{"depends_on_id":"ark-root","type":"parent-child"}]}
    ]).to_string());
    let mut app = Driven::bdi(18, 80, home, &tracker.environment());
    app.read_until(ENTER_ALTERNATE_SCREEN, GIVING_UP);
    app.read_until(b"Gateway", GIVING_UP);
    let expand = app.send(b"E");
    app.answer_to(expand, GIVING_UP);
    let search = app.send(b"\x06?~ refund\x1b[B");
    app.answer_to(search, GIVING_UP);
    let repaint = app.resize(19, 80);
    let screen = app.answer_to(repaint, GIVING_UP);
    let rows = terminal::rows_drawn(&screen);
    assert!(
        rows.iter().any(|row| row.starts_with("/?~ refund")),
        "prompt stays active: {rows:?}"
    );
    assert!(
        rows.iter().any(|row| row.contains("Refund alpha")),
        "{rows:?}"
    );
    assert!(
        rows.iter().any(|row| row.contains("Refund beta")),
        "{rows:?}"
    );
    assert!(
        !rows.iter().any(|row| row.contains("Other work")),
        "{rows:?}"
    );
    let accept = app.send(b"\r");
    app.answer_to(accept, GIVING_UP);
    let repaint = app.resize(18, 80);
    let screen = app.answer_to(repaint, GIVING_UP);
    assert!(
        !terminal::rows_drawn(&screen)
            .iter()
            .any(|row| row.contains("Other work")),
        "Enter keeps filter"
    );
    assert!(
        terminal::rows_drawn(&screen)
            .iter()
            .any(|row| row.contains("?~ refund")),
        "accepted filter stays visible"
    );
    let clear_filter = app.send(b"\x06\x01\x0b\r");
    app.answer_to(clear_filter, GIVING_UP);
    let repaint = app.resize(19, 80);
    let screen = app.answer_to(repaint, GIVING_UP);
    assert!(
        terminal::rows_drawn(&screen)
            .iter()
            .any(|row| row.contains("Other work")),
        "empty accepted filter clears prior search"
    );
    let clear = app.send(b"H?");
    app.answer_to(clear, GIVING_UP);
    let repaint = app.resize(12, 80);
    let before = app.answer_to(repaint, GIVING_UP);
    let scroll = app.send(b"\x1b[B\x1b[B\x1b[B\x1b[B");
    app.answer_to(scroll, GIVING_UP);
    let repaint = app.resize(13, 80);
    let after = app.answer_to(repaint, GIVING_UP);
    assert!(
        terminal::rows_drawn(&after)
            .iter()
            .any(|row| row.contains("Key bindings")),
        "help remains open"
    );
    assert_ne!(terminal::rows_drawn(&before), terminal::rows_drawn(&after));
    let close = app.send(b"\x1b");
    app.answer_to(close, GIVING_UP);
    app.send(b"q");
}
