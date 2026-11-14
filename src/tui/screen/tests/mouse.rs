//! Pointer gestures use the rendered viewport, including pinned headers.
use super::*;

fn pointer_row(shown: &Shown, screen: Rect, at: usize) -> u16 {
    let bands = draw::regions_for_layout(
        screen,
        shown.forest.lines().len(),
        shown.tail_band,
        &shown.drawing.layout,
    );
    let row = draw::visible_rows(
        &shown.forest,
        &shown.drawing.layout,
        bands.forest.height as usize,
    )
    .iter()
    .position(|row| row.at == Some(at))
    .unwrap();
    bands.forest.y + row as u16
}

#[test]
fn selected_parent_click_toggles_and_double_click_sets_root() {
    let mut shown = shown(a_grove(4));
    shown.drawing.layout = Layout::default();
    shown.forest.laid_out_to(shown.drawing.layout.clone());
    shown.forest.apply(Action::ExpandForest);
    let screen = Rect::new(0, 0, 80, 24);
    let at = shown
        .forest
        .lines()
        .viewport(0, shown.forest.lines().len())
        .find(|(_, line)| line.bead().is_some())
        .unwrap()
        .0;
    shown.select(at);
    let row = pointer_row(&shown, screen, at);
    let was = shown.forest.lines()[at].folded;
    assert!(shown.clicked(screen, row));
    assert_eq!(shown.forest.lines()[at].folded, was.map(|open| !open));
    assert!(shown.clicked(screen, row));
    assert!(
        !shown.forest.focused_on().is_empty(),
        "second click sets a root"
    );
}

#[test]
fn control_click_reveals_parent_root_and_selects_clicked_child() {
    let mut shown = shown(a_grove(4));
    shown.drawing.layout = Layout::default();
    shown.forest.laid_out_to(shown.drawing.layout.clone());
    shown.forest.apply(Action::ExpandForest);
    let root = shown
        .forest
        .lines()
        .viewport(0, shown.forest.lines().len())
        .find(|(_, line)| line.bead().is_some())
        .unwrap()
        .0;
    shown.select(root);
    shown.apply(Action::RootSelected);
    shown.apply(Action::ExpandForest);
    let child = shown
        .forest
        .lines()
        .viewport(0, shown.forest.lines().len())
        .filter(|(_, line)| line.bead().is_some())
        .nth(1)
        .unwrap()
        .0;
    let key = shown.forest.lines()[child].bead().unwrap().clone();
    let screen = Rect::new(0, 0, 80, 24);
    let row = pointer_row(&shown, screen, child);
    assert!(shown.ctrl_clicked(screen, row));
    assert!(shown.forest.focused_on().is_empty());
    assert_eq!(shown.selected_bead(), Some(&key));
}

#[test]
fn control_click_keeps_its_target_while_missing_ancestry_is_collected() {
    let mut partial = a_grove(3);
    let mut tree = (*partial.collected[0]).clone();
    tree.beads[0].parent = Some(Related {
        project: None,
        id: "grv-upper".into(),
        edge: Edge::ParentChild,
        status: Some(Status::Open),
        title: None,
    });
    partial.collected = vec![Arc::new(tree.clone())];
    partial.refilter(Filter::All);
    let mut complete = partial.clone();
    let mut upper = tree.beads[0].clone();
    upper.id = "grv-upper".into();
    upper.parent = None;
    upper.title = "Invented enclosing work".into();
    tree.beads.push(upper);
    tree.children.push(vec![Link {
        bead: 0,
        edge: Edge::ParentChild,
        first: true,
    }]);
    tree.root = "grv-upper".into();
    tree.counts = Counts::over(&tree.beads);
    complete.collected = vec![Arc::new(tree)];
    complete.refilter(Filter::All);

    let mut shown = shown(partial);
    shown.drawing.layout = Layout::default();
    shown.forest.laid_out_to(shown.drawing.layout.clone());
    shown.forest.go_to(&bead("grove", "grv-1"));
    shown.apply(Action::RootSelected);
    shown.apply(Action::ExpandForest);
    let clicked = bead("grove", "grv-1.2");
    let at = shown
        .forest
        .lines()
        .viewport(0, shown.forest.lines().len())
        .find(|(_, line)| line.bead() == Some(&clicked))
        .unwrap()
        .0;
    let screen = Rect::new(0, 0, 80, 24);
    let row = pointer_row(&shown, screen, at);
    assert!(shown.ctrl_clicked(screen, row));
    assert_eq!(
        shown.forest.focused_on(),
        [bead("grove", "grv-upper")].into()
    );
    shown.collected(complete);
    assert_eq!(shown.selected_bead(), Some(&clicked));
}
