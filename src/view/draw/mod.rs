//! The forest and the tail, drawn into a ratatui frame.
//!
//! One module for each thing drawn — a project's line, a bead's, the groups,
//! the foot, the tail — one for the bands they are drawn into, and one for
//! the colours they are drawn in. What is left here is the frame itself:
//! which kind of line each row is, and the few cells that more than one kind
//! draws with.

mod bands;
pub(in crate::view) mod bead;
mod foot;
mod groups;
mod project;
mod tail;
pub(crate) mod tone;

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use ratatui::layout::{Position, Rect};
use ratatui::style::Style;
use ratatui::text::Span;
use ratatui::Frame;

use crate::app::Awaited;
use crate::model::types::PaneStatus;
use crate::view::fitted::{Fitted, GAP};
use crate::view::forest::Forest;
use crate::view::lines::{self, Content, Note, ProjectLine, Waiting};
use crate::view::palette;
use crate::view::phrase;
use crate::view::query::Query;
use crate::view::row::{Cell, Layout, Widths, AGENT, WARNING};
use crate::view::{Freshness, Notice, Said};

#[cfg(test)]
pub use bands::line_at;
pub use bands::{key_rows, regions, Regions, TailBand};
pub(crate) use bead::identity_widths;
pub use tail::{draw_tail, Band};

use bead::{bead_line, elided_run, orphaned_line};
use foot::{notices, status_bar};
use groups::{group_line, item_line, scoped_line};
use project::{absent_line, project_line, unread_line};

/// Reserve a fixed legend row between the bead list and preview or shortcuts.
/// Tiny terminals keep a tree row and keys before allocating the legend.
pub fn regions_with_status(area: Rect, lines: usize, band: TailBand, enabled: bool) -> Regions {
    if enabled {
        compact_regions(area, lines, band, crate::view::tail::LINES)
    } else {
        regions(area, lines, band)
    }
}

/// Reserve configurable preview space, clamping it only to keep a tree row.
pub fn regions_for_layout(area: Rect, lines: usize, band: TailBand, layout: &Layout) -> Regions {
    if layout.compact {
        compact_regions(area, lines, band, layout.preview_min_height)
    } else {
        regions_with_status(area, lines, band, false)
    }
}

fn compact_regions(area: Rect, lines: usize, band: TailBand, minimum: u16) -> Regions {
    let mut bands = regions(area, lines, band);
    let rows = area.height - bands.keys.height;
    let legend = u16::from(rows >= 2);
    let available = rows.saturating_sub(legend);
    let tail = if band == TailBand::Shown {
        let free = available.saturating_sub(u16::try_from(lines).unwrap_or(u16::MAX));
        minimum
            .saturating_add(1)
            .max(free.min(area.height / 2))
            .min(available.saturating_sub(1))
    } else {
        0
    };
    bands.forest.height = available.saturating_sub(tail);
    bands.tail.y = area.y + bands.forest.height + legend;
    bands.tail.height = tail;
    bands
}

/// One screen row's source index and whether it also carries overflow dots.
#[derive(Debug, Clone, Copy)]
pub struct VisibleRow {
    pub at: Option<usize>,
    pub dots: bool,
}

/// Shared drawing and pointer geometry, using top-level headers without a walk.
pub fn visible_rows(forest: &Forest, layout: &Layout, height: usize) -> Vec<VisibleRow> {
    use crate::view::row::StickyHeaders;
    let from = forest.from();
    let lines = forest.lines();
    if !layout.compact {
        let (top, count, bottom) = bands::viewport(from, lines.len(), height);
        return (0..top)
            .map(|_| VisibleRow {
                at: None,
                dots: true,
            })
            .chain((from..from + count).map(|at| VisibleRow {
                at: Some(at),
                dots: false,
            }))
            .chain((0..bottom).map(|_| VisibleRow {
                at: None,
                dots: true,
            }))
            .collect();
    }
    if height == 0 {
        return Vec::new();
    }
    let headers = lines.project_headers();
    let mut above: Vec<_> = if from > 0 && height >= 3 {
        match layout.sticky_headers {
            StickyHeaders::Off => vec![None],
            StickyHeaders::Active => {
                vec![headers.iter().copied().filter(|at| *at <= from).next_back()]
            }
            StickyHeaders::All => headers
                .iter()
                .copied()
                .filter(|at| *at < from)
                .map(Some)
                .collect(),
        }
    } else {
        Vec::new()
    };
    let excess = above.len().saturating_sub(height.saturating_sub(1));
    above.drain(..excess);
    let mut below = Vec::new();
    if layout.sticky_headers == StickyHeaders::All && height >= 3 {
        // Reserve hidden following projects from the bottom inward. Bound by
        // screen height, leaving at least one actual content row.
        let room = height.saturating_sub(above.len() + 1);
        for at in headers.iter().copied().rev() {
            if below.len() >= room {
                break;
            }
            let end = from.saturating_add(height.saturating_sub(above.len() + below.len()));
            if at >= end {
                below.push(at);
            }
        }
        below.reverse();
    }
    let from = from
        + usize::from(
            layout.sticky_headers == StickyHeaders::Active
                && from > 0
                && above.contains(&Some(from)),
        );
    let count = height
        .saturating_sub(above.len() + below.len())
        .min(lines.len().saturating_sub(from));
    above
        .into_iter()
        .map(|at| VisibleRow { at, dots: true })
        .chain((from..from + count).map(|at| VisibleRow {
            at: Some(at),
            dots: false,
        }))
        .chain(below.into_iter().map(|at| VisibleRow {
            at: Some(at),
            dots: true,
        }))
        .collect()
}

/// Inverse of the rendered rows, including clickable sticky project headings.
pub fn forest_line_at(area: Rect, forest: &Forest, layout: &Layout, row: u16) -> Option<usize> {
    let within = row.checked_sub(area.y)? as usize;
    visible_rows(forest, layout, area.height as usize)
        .get(within)?
        .at
}

/// The selected bead's marker meaning; headers and summary rows have no bead state.
pub fn selected_status(forest: &Forest) -> Option<String> {
    match &forest.lines().get(forest.selected_line())?.content {
        Content::Bead(row) => Some(crate::view::row::appearance::description(
            &row.status,
            row.activity.as_ref(),
        )),
        _ => None,
    }
}

/// What every project line's freshness is drawn from: when each project was
/// last read, which projects have a read outstanding, which have lapsed, and
/// the instant this frame is being drawn at.
///
/// Gathered at the frame rather than held on the lines. A read being asked
/// for and coming back changes what a project line says without changing the
/// snapshot under it, and the mark turns between two collections' worth of
/// events — so a line that carried its own answer would have to be flattened
/// again to say anything new.
pub(super) struct Reads<'a> {
    read_at: &'a BTreeMap<String, DateTime<Utc>>,
    /// Every read outstanding — the collection in flight and whatever is
    /// queued behind it — and when each was asked for. The instant is what
    /// tells a read that is getting somewhere from one that has stopped.
    collecting: &'a [Awaited],
    /// The projects nothing has vouched for lately.
    lapsed: &'a [String],
    now: DateTime<Utc>,
}

impl<'a> Reads<'a> {
    pub(super) fn new(
        read_at: &'a BTreeMap<String, DateTime<Utc>>,
        collecting: &'a [Awaited],
        lapsed: &'a [String],
        now: DateTime<Utc>,
    ) -> Self {
        Self {
            read_at,
            collecting,
            lapsed,
            now,
        }
    }

    /// How fresh one project is.
    ///
    /// Whether a read of it is outstanding is asked with `Wanted::names`, of
    /// the very sequence the collector is served from, so the line and the
    /// collector agree by construction rather than by argument. How the last
    /// collection of it went comes off the line, because it changes only when
    /// the snapshot does.
    ///
    /// More than one outstanding read can name one project, and routinely
    /// does: a whole collection names every project, so one queued behind a
    /// single project — or with one queued behind it — names that project
    /// twice over. The reader's question is how long this project's rows have
    /// been on their way, so the answer is the earliest of them.
    fn of(&self, project: &ProjectLine) -> Option<Freshness> {
        let fresh = Freshness::of(
            self.read_at.get(&project.project).copied(),
            self.collecting
                .iter()
                .filter(|awaited| awaited.wanted.names(&project.project))
                .min_by_key(|awaited| awaited.asked_at),
            project.every_root_read,
            self.now,
        );
        if self.lapsed.contains(&project.project) {
            fresh.map(Freshness::lapsed)
        } else {
            fresh
        }
    }
}

/// What the row at the foot of the screen is handed: what this run cannot
/// do, what the reader has just copied, and the keys.
///
/// `keys` arrives already named. What a key is called belongs with the
/// mapping that answers it, and this file has never known one.
pub struct Foot<'a> {
    pub standing: &'a [Notice],
    /// What the reader's last keystroke came to, until their next key or
    /// click.
    pub said: Option<&'a Said>,
    /// What the reader has typed into the search prompt and where their
    /// cursor stands in it, while one is up.
    pub prompt: Option<&'a Query>,
    /// The row of keys and every shorter form of it the loop will stand
    /// behind, fullest first.
    pub keys: &'a [String],
}

/// Draw the forest and the foot into the bands `regions` gave them, leaving
/// the tail's band to whoever holds a tail.
#[allow(clippy::too_many_arguments)]
pub fn draw(
    frame: &mut Frame,
    bands: Regions,
    forest: &Forest,
    layout: &Layout,
    collecting: &[Awaited],
    lapsed: &[String],
    now: DateTime<Utc>,
    foot: Foot,
) {
    let lines = forest.lines();
    let selected = forest.selected_line();
    let height = bands.forest.height as usize;
    let widths = lines.widths();
    let reads = Reads::new(&forest.snapshot().read_at, collecting, lapsed, now);

    let layout = resolved_layout(layout, lines.project_headers().len());
    let rows = visible_rows(forest, &layout, height);
    for (row, visible) in rows.iter().enumerate() {
        let area = Rect {
            y: bands.forest.y + row as u16,
            height: 1,
            ..bands.forest
        };
        if let Some(at) = visible.at {
            if let Some(line) = lines.get(at) {
                let drawn = fitted(line, widths, &layout, &reads);
                frame.render_widget(
                    if at == selected {
                        drawn.selected()
                    } else {
                        drawn
                    },
                    area,
                );
            }
        }
        if visible.dots {
            frame.render_widget(ratatui::text::Line::from("...").centered(), area);
        }
    }
    if layout.compact && bands.forest.height > 0 && bands.tail.y > bands.forest.bottom() {
        let y = bands.forest.bottom();
        let area = Rect {
            y,
            height: 1,
            ..bands.forest
        };
        let last = rows
            .iter()
            .filter(|row| !row.dots)
            .filter_map(|row| row.at)
            .next_back();
        let below = last.is_some_and(|at| at + 1 < lines.len());
        let status = selected_status(forest).unwrap_or_default();
        // Limit the legend to the left half when dots share its row.
        let legend = Rect {
            width: if below { area.width / 2 } else { area.width },
            ..area
        };
        frame.render_widget(ratatui::text::Line::raw(status), legend);
        if below {
            frame.render_widget(ratatui::text::Line::from("...").centered(), area);
        }
    }

    frame.render_widget(
        status_bar(
            &notices(forest.snapshot(), foot.standing),
            foot.said,
            foot.prompt.map(Query::typed),
            foot.keys,
            forest.spine(),
            forest.is_focused(),
            bands.keys.width as usize,
        ),
        bands.keys,
    );
    if let Some(query) = foot.prompt {
        frame.set_cursor_position(prompt_cursor(query, bands.keys));
    }
}

/// Where the terminal's cursor goes while the prompt is up: in the query where
/// the reader is typing, and never past the last column of the row.
fn prompt_cursor(query: &Query, row: Rect) -> Position {
    let into = phrase::prompt("").chars().count() + query.columns_before_cursor();
    let last = row.width.saturating_sub(1);
    Position {
        x: row.x + u16::try_from(into).unwrap_or(u16::MAX).min(last),
        y: row.y,
    }
}

/// Resolve project-count-dependent indentation once for every row type.
fn resolved_layout(layout: &Layout, projects: usize) -> Layout {
    let mut layout = layout.clone();
    if layout.root_indent == crate::view::row::RootIndent::SingleTree {
        layout.root_indent = if projects == 1 {
            crate::view::row::RootIndent::Always
        } else {
            crate::view::row::RootIndent::Never
        };
    }
    layout
}

/// One line of the forest, whatever kind it is.
pub(super) fn fitted(
    line: &lines::Line,
    widths: &Widths,
    layout: &Layout,
    reads: &Reads,
) -> Fitted {
    // Only the project level is removed. Global groups keep their own tree.
    let hide = layout.compact && layout.root_indent == crate::view::row::RootIndent::Always;
    let under_project = match &line.content {
        Content::Project(_) | Content::Scoped { .. } | Content::Section { .. } => false,
        Content::Group(group) => group.project.is_some(),
        Content::Item(item) => matches!(item, lines::Item::Loose(_)),
        _ => true,
    };
    let prefix = if hide && under_project {
        if matches!(&line.content, Content::Group(_)) && line.depth == 1 {
            format!(
                "{} ",
                lines::marker_with(line.folded.unwrap_or(true), layout.ascii)
            )
        } else {
            line.prefix
                .chars()
                .skip(2 + usize::from(layout.indent))
                .collect()
        }
    } else {
        line.prefix.clone()
    };
    let prefix = if layout.compact && matches!(&line.content, Content::Project(_)) {
        format!(" {prefix}")
    } else if layout.compact && matches!(&line.content, Content::Group(_)) {
        // Move even a tight elbow's arrow; reuse a following gap if present.
        if let Some(at) = prefix.find(['▸', '▾', '>', 'v']) {
            let arrow = prefix[at..].chars().next().unwrap();
            let after = &prefix[at + arrow.len_utf8()..];
            format!(
                "{} {arrow}{}",
                &prefix[..at],
                after.strip_prefix(' ').unwrap_or(after)
            )
        } else {
            prefix
        }
    } else {
        prefix
    };
    match &line.content {
        Content::Project(project) => project_line(project, &prefix, reads.of(project), reads.now),
        Content::Unread(unread) => unread_line(unread, &prefix, widths.of(&Cell::Id)),
        Content::Absent(absent) => absent_line(absent, &prefix, widths.of(&Cell::Id)),
        Content::Bead(row) | Content::Waiting(Waiting { row, .. }) => {
            let fitted = bead_line(row, &prefix, widths, layout);
            if layout.compact && line.folded == Some(false) && !prefix.contains(['├', '└', '+'])
            {
                fitted.fold_hint(if layout.ascii { '>' } else { '▸' })
            } else {
                fitted
            }
        }
        Content::Elided { count, .. } => elided_run(&prefix, *count),
        Content::Orphaned(orphaned) => orphaned_line(orphaned, &prefix, widths.of(&Cell::Id)),
        Content::Note(note) => {
            let (said, style) = finding(*note);
            sentence(&prefix, said, style)
        }
        Content::Group(group) => group_line(&prefix, group),
        Content::Item(item) => item_line(&prefix, item),
        Content::Scoped { project } => scoped_line(&prefix, project),
        Content::Section { section, count } => {
            sentence(&prefix, phrase::section(section, *count), palette::HEADING)
        }
    }
}

/// A line that is one sentence and nothing else.
pub(super) fn sentence(prefix: &str, said: String, style: Style) -> Fitted {
    Fitted::new(
        vec![Span::raw(prefix.to_string()), Span::styled(said, style)],
        Vec::new(),
        Vec::new(),
    )
}

/// A finding about the tree above, in `bdi`'s words for it, and what it is
/// said in.
///
/// An empty forest is the one note nothing went wrong in — the trackers
/// answered and there was no work — so it alone is drawn plain, the way
/// `group_line` draws the hidden trees.
fn finding(note: Note) -> (String, Style) {
    let said = match note {
        Note::OrphanedDependencies(count) => phrase::orphaned_dependency(count),
        Note::Cycle(count) => phrase::cycle(count),
        Note::ToCheck(count) => phrase::to_check_in_the_forest(count),
        Note::Unread(count) => phrase::unread_trees(count),
        Note::FailedProjects(count) => phrase::failed_projects(count),
        Note::NoRoots => return (phrase::no_roots().to_string(), palette::PLAIN),
    };
    (format!("{WARNING} {said}"), palette::ATTENTION)
}

/// How far along something is. A tree and one epic inside it ask the same
/// question of different scopes, so they answer it in the same words.
pub(super) fn done(finished: usize, total: usize) -> String {
    format!("{finished}/{total}")
}

/// Put a cell in a row's state block, beside the ones already there.
///
/// The gap belongs *between* the cells: two that abut read as one that names
/// neither, and a gap in front of the first is spent rather than seen,
/// because the block is set against the row's right edge and the padding
/// swallows it. Every state block on a row is built this way, so there is one
/// place to be right about it rather than one per kind of row.
pub(super) fn beside(state: &mut Vec<Span<'static>>, cell: Span<'static>) {
    if !state.is_empty() {
        state.push(Span::raw(" ".repeat(GAP)));
    }
    state.push(cell);
}

pub(super) fn pane_marker(pane: &str, status: &PaneStatus) -> String {
    format!("{AGENT} {pane} {}", phrase::pane_state(status))
}

/// The box-drawing a line hangs under. It says how the tree is shaped rather
/// than how a bead is going, so it is held at the terminal's default while the
/// row around it dims or brightens. `bd list` leaves its own tree prefix
/// undimmed on a closed row too.
pub(super) fn structure(prefix: &str) -> Span<'static> {
    Span::styled(prefix.to_string(), palette::STRUCTURE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::types::testing::key;
    use crate::model::types::Printed;
    use pretty_assertions::assert_eq;
    use ratatui::style::Color;
    use ratatui::style::Modifier;
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::Arc;

    use crate::app::Wanted;
    use crate::config::Scope;
    use crate::model::join::{AgentRef, BeadKey, JoinSource};
    use crate::model::snapshot::{
        a_provider, Counts, Filter, HiddenTree, LoosePane, Node, ProviderState, Snapshot,
        TrackerFailure, TrackerState, Tree,
    };
    use crate::model::tree::Link;
    use crate::model::types::{Edge, Status};
    use crate::model::watching::Watching;
    use crate::view::forest::flatten;
    use crate::view::row::{self, Row};
    use crate::view::{Action, Edit, Motion};
    use chrono::{DateTime, TimeZone, Utc};

    pub(super) use crate::view::painted::Painted;
    pub(super) use crate::view::tests::{does_not_say, says};

    pub(super) const OPEN: &str = "▾ ";
    pub(super) const SHUT: &str = "▸ ";
    pub(super) const BRANCH: &str = "  ├── ";
    pub(super) const LAST: &str = "  └── ";

    /// A run of closed siblings, under whichever bead the test likes: the
    /// drawing says the count and nothing about the bead it hangs under.
    pub(super) fn elided(count: usize) -> Content {
        Content::Elided {
            count,
            under: lines::Place::root(BeadKey {
                project: "dunwich".into(),
                id: "dun-7".into(),
            }),
        }
    }

    /// One forest line, behind the box-drawing a flatten would have put in
    /// front of it.
    pub(super) fn under(prefix: &str, content: Content) -> lines::Line {
        lines::Line {
            prefix: prefix.into(),
            depth: 1,
            folded: None,
            place: None,
            content,
        }
    }

    pub(super) fn counts(
        finished: usize,
        total: usize,
        live_agents: usize,
        anomalies: usize,
    ) -> Counts {
        Counts {
            total,
            finished,
            live_agents,
            anomalies,
        }
    }

    pub(super) fn tree(project: &str, root: &str, title: &str, counts: Counts) -> Tree {
        Tree {
            project: project.into(),
            root: root.into(),
            title: title.into(),
            counts,
            tracker: TrackerState::Ok,
            beads: Vec::new(),
            children: Vec::new(),
            orphaned_dependencies: Vec::new(),
            cycles: Vec::new(),
        }
    }

    pub(super) fn node(id: &str, title: &str, status: Status) -> Node {
        Node {
            activity: None,
            disposable_fixture: false,
            project: "summit-works".to_string(),
            id: id.into(),
            title: title.into(),
            status,
            issue_type: "task".into(),
            priority: 2,
            ready: false,
            blocked_by: Vec::new(),
            started_at: None,
            closed_at: None,
            badges: Vec::new(),
            undrawn: Vec::new(),
            agent: None,
            watching: crate::model::watching::Watching::nobody(),
            anomalies: Vec::new(),
            orphaned_dependencies: Vec::new(),
            row: Printed::saying("", ""),
            created_by: None,
            assignee: None,
            labels: Vec::new(),
            views: Vec::new(),
            created_at: None,
            updated_at: None,
            defer_until: None,
            due_at: None,
            lease_expires_at: None,
            metadata: Default::default(),
            parent: None,
            depends_on: Vec::new(),
            blocks: Vec::new(),
        }
    }

    pub(super) fn pane(pane: &str, status: PaneStatus) -> LoosePane {
        LoosePane {
            pane: key(pane),
            project: "summit-works".into(),
            cwd: "/tmp/bdi-ground/summit-works".into(),
            pane_status: status,
            display_agent: None,
            title: None,
            claim_refused: false,
        }
    }

    pub(super) fn row(node: &Node) -> Row {
        row::cells(node, Some("smt-4kd3p"), None, None)
    }

    /// A width table padding the id alone, as the default layout's forest
    /// answers.
    pub(super) fn ids(width: usize) -> Widths {
        Widths::from([(Cell::Id, width)])
    }

    /// A project whose roots all read, so its line is its name and its counts.
    pub(super) fn project(name: &str, counts: Counts) -> ProjectLine {
        ProjectLine {
            project: name.into(),
            counts,
            every_root_read: true,
        }
    }

    /// A pane with something on it, which is all most of these rows need to
    /// know about an agent.
    pub(super) fn a_pane() -> AgentRef {
        AgentRef {
            pane: key("wCM:p9"),
            pane_status: PaneStatus::Working,
            title: None,
            source: JoinSource::AgentPane,
            agent_session: None,
        }
    }

    /// A key row shaped like the real one, without importing the loop's.
    pub(super) const A_KEY_ROW: &str = "Enter focus   a all   ? keys   ^R refresh   q quit";

    /// It as the foot takes it: one form, so it goes whole or not at all.
    pub(super) fn a_key_row() -> Vec<String> {
        vec![A_KEY_ROW.to_string()]
    }

    /// A blocker no tracker holds is drawn as its id and why, as a root that
    /// would not read is, on the arm the blocker would have hung on.
    #[test]
    fn a_blocker_no_tracker_holds_is_drawn_as_its_id_and_why() {
        let orphaned = crate::model::tree::OrphanedDependency {
            id: "dun-404".into(),
            why: crate::model::tree::Unreachable::NotRead {
                projects: vec!["ferry".into()],
            },
            may_block: true,
        };
        let painted = Painted::of(
            fitted(
                &under("└┄┄ ", Content::Orphaned(orphaned)),
                &ids(7),
                &Layout::legacy(),
                &at_rest(),
            ),
            96,
            1,
        )
        .row(0);
        let said: String = painted.iter().map(|cell| cell.said.as_str()).collect();

        assert!(
            said.starts_with("└┄┄ ⚠ dun-404 ") && said.contains("not read: ferry"),
            "{said:?}"
        );
        assert_eq!(painted[0].style.fg, Some(Color::Reset));
        assert!(
            painted
                .iter()
                .any(|cell| cell.said.contains("not read: ferry")
                    && cell.style.fg == palette::ATTENTION.fg),
            "{painted:?}"
        );
    }

    #[test]
    fn a_note_leaves_its_box_drawing_in_the_terminals_own_colour() {
        let painted = Painted::of(
            fitted(
                &under(LAST, Content::Note(Note::OrphanedDependencies(2))),
                &ids(0),
                &Layout::legacy(),
                &at_rest(),
            ),
            96,
            1,
        )
        .row(0);

        assert_eq!(painted[0].said, LAST);
        assert_eq!(painted[0].style.fg, Some(Color::Reset));
        assert_eq!(painted[1].style.fg, palette::ATTENTION.fg);
    }

    /// Every other note is a fault and wears a warning. Nothing went wrong in
    /// a forest with no work left in it, and a warning over that reads as one
    /// — so it is drawn plain, in one colour the whole way across.
    #[test]
    fn the_line_for_an_empty_forest_is_drawn_in_the_terminals_own_colour() {
        let painted = Painted::of(
            fitted(
                &under("", Content::Note(Note::NoRoots)),
                &ids(0),
                &Layout::legacy(),
                &at_rest(),
            ),
            96,
            1,
        )
        .row(0);

        assert_eq!(painted.len(), 1, "{painted:?}");
        assert_eq!(painted[0].style.fg, Some(Color::Reset));
        assert!(!painted[0].said.contains(WARNING), "{painted:?}");
    }

    // ---- the whole frame -------------------------------------------------

    pub(super) fn snapshot(
        trees: Vec<Tree>,
        unattributed: Vec<LoosePane>,
        agents: ProviderState,
    ) -> Snapshot {
        // The projects a real collection would have named beside these trees,
        // in the order the trees arrive in.
        let mut projects: Vec<String> = Vec::new();
        for tree in &trees {
            if projects.last() != Some(&tree.project) {
                projects.push(tree.project.clone());
            }
        }
        let trees: Vec<Arc<Tree>> = trees.into_iter().map(Arc::new).collect();

        Snapshot {
            generated_at: Utc.with_ymd_and_hms(2026, 8, 30, 10, 22, 14).unwrap(),
            agents: a_provider(agents),
            filter: Filter::All,
            collected: trees.clone(),
            out_of_focus: BTreeSet::new(),
            trees,
            projects,
            views: Vec::new(),
            scope: Scope::default(),
            hidden_trees: Vec::new(),
            failed_projects: Vec::new(),
            unattributed,
            unconfigured: Vec::new(),
            conflicts: Vec::new(),
            projects_named_without_git: Vec::new(),
            unanswered_by_the_watcher: Vec::new(),
            read_at: BTreeMap::from([("summit-works".to_string(), read_at())]),
            speaks_until: BTreeMap::new(),
        }
    }

    /// When the fixture's tracker was read. Half a minute before the
    /// snapshot was generated, so a frame quoting the wrong one of the two
    /// says so rather than agreeing by coincidence.
    pub(super) fn read_at() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, 30, 10, 21, 44).unwrap()
    }

    /// The instant a test frame is drawn at: the snapshot's own. The read
    /// behind it is half a minute older, so a project line drawn from it is
    /// half a minute stale.
    pub(super) fn drawn_at() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, 30, 10, 22, 14).unwrap()
    }

    /// Nothing has been read and nothing is being read, for the lines that
    /// say nothing about either.
    static NOTHING_READ: BTreeMap<String, DateTime<Utc>> = BTreeMap::new();

    pub(super) fn at_rest() -> Reads<'static> {
        Reads::new(&NOTHING_READ, &[], &[], drawn_at())
    }

    /// One tree of `children` open beads under an in-flight root.
    pub(super) fn grove(children: usize) -> Tree {
        let mut beads = vec![node(
            "smt-4kd3p",
            "lift the ground station",
            Status::InProgress,
        )];
        for child in 1..=children {
            beads.push(node(
                &format!("smt-4kd3p.{child}"),
                &format!("bead number {child}"),
                Status::Open,
            ));
        }

        Tree {
            counts: counts(0, beads.len(), 0, 0),
            children: under_the_root(&beads),
            beads,
            ..tree(
                "summit-works",
                "smt-4kd3p",
                "lift the ground station",
                counts(0, 0, 0, 0),
            )
        }
    }

    /// The ways down a tree of one root over leaves: every other bead hangs
    /// under the first, and nothing hangs under them.
    pub(super) fn under_the_root(beads: &[Node]) -> Vec<Vec<Link>> {
        let mut children = vec![(1..beads.len())
            .map(|bead| Link {
                bead,
                edge: Edge::ParentChild,
                first: true,
            })
            .collect()];
        children.resize(beads.len(), Vec::new());
        children
    }

    /// A forest with its first tree opened by hand. Nothing in these fixtures
    /// is staffed, so the fold default rests every tree as its header, and
    /// what these tests are about is the rows under one.
    pub(super) fn opened(snapshot: &Snapshot) -> Forest {
        let mut forest = flatten(snapshot.clone());
        forest.laid_out_to(Layout::legacy());
        forest.apply(Action::ExpandForest);
        forest
    }

    fn legacy_forest(snapshot: Snapshot) -> Forest {
        let mut forest = flatten(snapshot);
        forest.laid_out_to(Layout::legacy());
        forest
    }

    pub(super) fn frame_of(forest: &Forest, width: u16, height: u16) -> Painted {
        frame_collecting(forest, &[], width, height)
    }

    /// A collection reading `wanted`, asked for at the instant the frame is
    /// drawn — so it is a collection under way rather than one that has
    /// stopped answering.
    pub(super) fn reading(wanted: Wanted) -> Awaited {
        Awaited {
            wanted,
            asked_at: drawn_at(),
            patience: PATIENCE,
        }
    }

    /// How long the collections these tests build may go unanswered. A round
    /// number the instants are written against, rather than the configured
    /// default: what they assert is which mark a wait produces, not what the
    /// deadline is.
    pub(super) const PATIENCE: chrono::TimeDelta = chrono::TimeDelta::seconds(30);

    /// The same frame with a collection in flight, so a project line the
    /// collection names says so.
    pub(super) fn frame_collecting(
        forest: &Forest,
        collecting: &[Awaited],
        width: u16,
        height: u16,
    ) -> Painted {
        frame_with(forest, &[], collecting, width, height)
    }

    fn frame_with(
        forest: &Forest,
        standing: &[Notice],
        collecting: &[Awaited],
        width: u16,
        height: u16,
    ) -> Painted {
        let keys = a_key_row();
        Painted::drawn_by(width, height, |frame| {
            draw(
                frame,
                regions(frame.area(), forest.lines().len(), TailBand::Shown),
                forest,
                &Layout::legacy(),
                collecting,
                &[],
                drawn_at(),
                Foot {
                    standing,
                    said: None,
                    prompt: None,
                    keys: &keys,
                },
            );
        })
    }

    /// Where the terminal's cursor stands once a frame with the prompt up is
    /// drawn, `width` columns wide.
    fn cursor_over(query: &Query, width: u16) -> Position {
        let forest = opened(&snapshot(
            vec![grove(2)],
            Vec::new(),
            ProviderState::NotAnswering,
        ));
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, 10))
            .expect("a test backend");
        terminal
            .draw(|frame| {
                draw(
                    frame,
                    regions(frame.area(), forest.lines().len(), TailBand::Shown),
                    &forest,
                    &Layout::legacy(),
                    &[],
                    &[],
                    drawn_at(),
                    Foot {
                        standing: &[],
                        said: None,
                        prompt: Some(query),
                        keys: &a_key_row(),
                    },
                );
            })
            .expect("a draw into memory");
        terminal.get_cursor_position().expect("a cursor")
    }

    fn a_query(typed: &str, edits: &[Edit]) -> Query {
        let mut query = Query::default();
        for edit in typed
            .chars()
            .map(Edit::Character)
            .chain(edits.iter().copied())
        {
            query.edit(edit);
        }
        query
    }

    /// The cursor is drawn where the reader is typing, on the foot, behind
    /// the `/` and the part of the query before it.
    #[test]
    fn the_prompt_draws_the_cursor_where_the_reader_is_typing() {
        let foot = 9;
        assert_eq!(
            cursor_over(&a_query("grv-1", &[]), 60),
            Position::new(6, foot)
        );
        assert_eq!(
            cursor_over(&a_query("grv-1", &[Edit::Start]), 60),
            Position::new(1, foot)
        );
        assert_eq!(
            cursor_over(&a_query("grv-1", &[Edit::Back, Edit::Back]), 60),
            Position::new(4, foot)
        );
    }

    /// A query longer than the row keeps its cursor on the row.
    #[test]
    fn the_cursor_stays_on_the_row_past_its_last_column() {
        assert_eq!(
            cursor_over(&a_query("a query longer than the row", &[]), 12),
            Position::new(11, 9)
        );
    }

    /// The whole screen, character for character: five rows of forest, four of
    /// reserved tail, and the foot.
    #[test]
    fn a_frame_is_the_forest_the_tails_reserved_band_and_the_foot() {
        let forest = opened(&snapshot(
            vec![grove(2)],
            Vec::new(),
            ProviderState::NotAnswering,
        ));

        assert_eq!(
            frame_of(&forest, 60, 10).rows(),
            vec![
                "▾ summit-works  ✓ 30s ago                                0/3",
                "  └── ◐ smt-4kd3p  lift the ground station               0/3",
                "      ├── ○ .1         bead number 1                        ",
                "      └── ○ .2         bead number 2                        ",
                "                                                            ",
                "                                                            ",
                "                                                            ",
                "                                                            ",
                "                                                            ",
                "⚠ no herdr session · agents are not shown                   ",
            ]
        );
    }

    /// The mark sits at the end of the watched bead's row and names nobody,
    /// and the bead nobody watches beside it carries none.
    #[test]
    fn a_frame_marks_the_row_of_a_bead_another_agent_watches() {
        let mut watched = grove(2);
        watched.beads[1].watching = Watching::Known {
            agents: Vec::new(),
            unreported: 1,
        };
        let forest = opened(&snapshot(
            vec![watched],
            Vec::new(),
            ProviderState::NotAnswering,
        ));

        assert_eq!(
            frame_of(&forest, 60, 10).rows()[1..4],
            [
                "  └── ◐ smt-4kd3p  lift the ground station               0/3",
                "      ├── ○ .1         bead number 1                       ◉",
                "      └── ○ .2         bead number 2                        ",
            ]
        );
    }

    /// A project's fraction is over every tree it holds, said in the words the
    /// reader sees: the filter takes a tree off the screen and leaves the
    /// count where it was. The group line is what says the filter is holding
    /// one back, so a fixture that quietly showed both trees fails here rather
    /// than agreeing with the fraction by coincidence.
    #[test]
    fn a_projects_fraction_counts_the_tree_the_filter_holds_back() {
        let beads = vec![node("smt-7bv1n", "raise the mast", Status::Open)];
        let mut held_back = tree(
            "summit-works",
            "smt-7bv1n",
            "raise the mast",
            Counts::over(&beads),
        );
        held_back.children = under_the_root(&beads);
        held_back.beads = beads;

        let shown = grove(2);
        let mut snapshot = snapshot(
            vec![shown.clone(), held_back.clone()],
            Vec::new(),
            ProviderState::Answering,
        );
        snapshot.filter = Filter::LiveAgents;
        snapshot.trees = vec![Arc::new(shown)];
        snapshot.hidden_trees = vec![HiddenTree::of(&held_back)];

        let frame = frame_of(&legacy_forest(snapshot), 60, 8).rows();

        assert!(
            frame
                .iter()
                .any(|row| row.contains("1 tree with no live agent")),
            "{frame:#?}"
        );
        assert!(
            frame[0].contains("0/4"),
            "three beads on screen and one held back is four: {frame:#?}"
        );
    }

    /// The bead's own case, at the whole-frame level: a `bdi` that could not
    /// open its socket says so at the foot, and it is the same row and the
    /// same shape a herdr failure uses. Nothing above the foot changes,
    /// because nothing above the foot is wrong.
    #[test]
    fn a_socket_that_would_not_open_is_said_at_the_foot_of_the_frame() {
        let forest = opened(&snapshot(
            vec![grove(2)],
            Vec::new(),
            ProviderState::Answering,
        ));

        assert_eq!(
            frame_with(&forest, &[Notice::NoInboundChannel], &[], 80, 10).rows(),
            vec![
                "▾ summit-works  ✓ 30s ago                                                    0/3",
                "  └── ◐ smt-4kd3p  lift the ground station                                   0/3",
                "      ├── ○ .1         bead number 1                                            ",
                "      └── ○ .2         bead number 2                                            ",
                "                                                                                ",
                "                                                                                ",
                "                                                                                ",
                "                                                                                ",
                "                                                                                ",
                "⚠ bdi cannot hear about changes · every project is polled instead               ",
            ]
        );
    }

    /// The definition of done's first case, at the whole-frame level: a narrow
    /// screen cuts every row and wraps none, so the row count on screen still
    /// matches the line count in the forest.
    #[test]
    fn a_narrow_frame_cuts_every_row_and_wraps_none() {
        let forest = opened(&snapshot(
            vec![grove(2)],
            Vec::new(),
            ProviderState::Answering,
        ));
        let frame = frame_of(&forest, 24, 10).rows();

        assert_eq!(
            frame[..4].to_vec(),
            vec![
                "▾ summit-works       0/3",
                "  └── ◐ smt-4kd3p    0/3",
                "      ├── ○ .1         …",
                "      └── ○ .2         …",
            ]
        );
        assert!(
            frame[4..9].iter().all(|row| row.trim().is_empty()),
            "{frame:?}"
        );
    }

    /// The definition of done's second case: however far the selection moves,
    /// the row it is on is drawn.
    #[test]
    fn the_selected_row_is_drawn_wherever_the_selection_has_moved_to() {
        let mut forest = legacy_forest(snapshot(
            vec![grove(40)],
            Vec::new(),
            ProviderState::Answering,
        ));

        for motion in [Motion::LastRow, Motion::FirstRow, Motion::HalfScreenDown] {
            forest.apply(Action::Move(motion));
            let at = forest.selected_line();
            let said = match &forest.lines()[at].content {
                Content::Bead(row) => row.title.clone(),
                Content::Project(line) => line.project.clone(),
                other => panic!("unexpected line under the selection: {other:?}"),
            };
            let frame = frame_of(&forest, 60, 10).rows();

            assert!(
                frame.iter().any(|row| row.contains(&said)),
                "{motion:?} put line {at} ({said}) off screen: {frame:?}"
            );
        }
    }

    /// Which row the cursor is on, and only that one.
    ///
    /// `Fitted::selected` reverses the row's whole style and moves not one
    /// word, so nothing in the symbols says where the cursor is: a frame that
    /// drew every row selected but the selected one reads the same as a
    /// correct one.
    #[test]
    fn the_row_under_the_cursor_is_the_only_one_drawn_reversed() {
        let mut forest = opened(&snapshot(
            vec![grove(2)],
            Vec::new(),
            ProviderState::Answering,
        ));
        forest.apply(Action::Move(Motion::FirstRow));
        forest.apply(Action::Move(Motion::NextRow));
        let selected = forest.selected_line();
        let lines = forest.lines().len();

        let frame = frame_of(&forest, 60, 10);

        for at in 0..lines {
            let reversed = frame
                .row(at)
                .iter()
                .all(|run| run.style.add_modifier.contains(Modifier::REVERSED));

            assert_eq!(
                reversed,
                at == selected,
                "row {at} of {lines}, cursor on {selected}: {:?}",
                frame.row(at)
            );
        }
    }

    /// The definition of done's third case: a root nobody could read renders
    /// as the root it is, the reason it failed, and — under its project's
    /// line, after the root — the panes still working there.
    #[test]
    fn a_root_that_would_not_read_draws_its_reason_and_its_projects_panes() {
        let failed =
            Tree::tracker_unreachable("summit-works", "smt-4kd3p", TrackerFailure::Unavailable);
        let forest = legacy_forest(snapshot(
            vec![failed],
            vec![pane("wCM:p9", PaneStatus::Working)],
            ProviderState::Answering,
        ));
        let frame = frame_of(&forest, 77, 8).rows();

        assert_eq!(
            frame[..4],
            [
                "▾ summit-works  ⚠ 30s ago                                                    ",
                "  ├── ⚠ smt-4kd3p  the tracker did not answer                                ",
                "  └── ⚠ 1 unclaimed pane                                                     ",
                "      └── ◍ wCM:p9 working  /tmp/bdi-ground/summit-works                     ",
            ]
        );
    }

    /// A tracker is read whole, so a row bdi refused would cost every bead
    /// in the project, not one field on one bead. The capture holds one row
    /// of every shape bd wrote while it spelled `metadata` as a string, each
    /// a loose root, and the frame drawn from it holds every one. The badge
    /// on `phase` says the string was read as the object it spells rather
    /// than merely tolerated.
    #[test]
    fn a_tracker_written_before_the_metadata_cutover_draws_its_beads() {
        use crate::collect::agents::testing::Fake as Provider;
        use crate::collect::bd::parse_beads;
        use crate::collect::tracker::testing::{Fake, Fakes};
        use crate::config::Config;

        let cfg = Config::from_toml(
            r#"
[[projects]]
name = "dunwich"
path = "/tmp/bdi-ground/dunwich"

[[badges]]
key = "metadata.phase"
render = "{}"
"#,
        )
        .expect("the config parses");
        let capture = include_str!("../../../tests/fixtures/bd_before_the_metadata_cutover.json");
        let trackers = Fakes::default().with(
            "dunwich",
            Fake::holding(parse_beads(capture).expect("the capture parses")),
        );
        let snapshot = crate::app::run(
            &cfg,
            &Provider::holding(Vec::new()),
            &trackers,
            Filter::All,
            drawn_at(),
        );

        let frame = frame_of(&legacy_forest(snapshot), 120, 40).rows();

        for bead in ["dun-v1", "dun-v2", "dun-v3", "dun-v4", "dun-v5", "dun-v6"] {
            assert!(
                frame.iter().any(|row| row.contains(bead)),
                "{bead} is on no row of {frame:#?}"
            );
        }
        assert!(
            frame.iter().any(|row| row.contains("vacuum-soak")),
            "the badge on phase is on no row of {frame:#?}"
        );
    }

    /// An unread root has no row of its own to measure, so its id is padded to
    /// the id column the bead rows settled between them: the reason beside it
    /// starts where their titles do.
    #[test]
    fn an_unread_roots_reason_starts_where_the_bead_rows_titles_do() {
        let unreadable =
            Tree::tracker_unreachable("summit-works", "smt-7", TrackerFailure::Unavailable);
        let forest = opened(&snapshot(
            vec![grove(1), unreadable],
            Vec::new(),
            ProviderState::Answering,
        ));
        let frame = frame_of(&forest, 70, 7).rows();

        assert_eq!(
            frame[1..4],
            [
                "  ├── ◐ smt-4kd3p  lift the ground station                         0/2",
                "  │   └── ○ .1         bead number 1                                  ",
                "  └── ⚠ smt-7      the tracker did not answer                         ",
            ]
        );
    }

    /// A root with nothing under it has no fold for a marker to stand for, so
    /// it draws none — and it still starts in the column its siblings start
    /// in, because a reader running down a project's roots finds every one of
    /// them in the same place.
    #[test]
    fn a_root_with_nothing_under_it_draws_no_marker_and_still_lines_up() {
        let unreadable =
            Tree::tracker_unreachable("summit-works", "smt-4kd3p", TrackerFailure::Unavailable);
        let forest = legacy_forest(snapshot(
            vec![grove(2), unreadable],
            Vec::new(),
            ProviderState::Answering,
        ));
        let frame = frame_of(&forest, 90, 5).rows();
        // The project's own line wears the warning too — one of its roots
        // would not read, which is what this fixture is — so the root is
        // found by the warning and its own id together.
        let unread = frame
            .iter()
            .position(|row| row.contains(WARNING) && row.contains("smt-4kd3p"))
            .expect("the root that would not read");
        let column = |row: &str| {
            let byte = row.find("smt-4kd3p").expect("the root on the row");
            row[..byte].chars().count()
        };

        assert!(
            !frame[unread].contains(SHUT.trim()),
            "nothing opens this root, so nothing should say it is shut: {:?}",
            frame[unread]
        );
        assert_eq!(
            column(&frame[unread]),
            column(&frame[1]),
            "the mark stands where a status glyph does:\n{}\n{}",
            frame[1],
            frame[unread]
        );
    }
}

#[cfg(test)]
mod compact_controls {
    use super::tests::*;
    use super::*;
    use crate::model::snapshot::ProviderState;
    use crate::view::painted::Painted;
    use crate::view::row::{RootIndent, StickyHeaders};
    use crate::view::{Action, Motion, Notch};

    fn forest() -> Forest {
        let mut trees = Vec::new();
        for project in ["summit-works", "arkham", "dunwich"] {
            let mut tree = grove(12);
            tree.project = project.into();
            for bead in &mut tree.beads {
                bead.project = project.into();
            }
            trees.push(tree);
        }
        let mut forest = opened(&snapshot(trees, Vec::new(), ProviderState::Answering));
        forest.laid_out_to(Layout::default());
        forest.apply(Action::ExpandForest);
        forest
    }

    #[test]
    fn sticky_headers_and_pointer_rows_share_geometry_at_every_scroll_offset() {
        for sticky_headers in [
            StickyHeaders::Off,
            StickyHeaders::Active,
            StickyHeaders::All,
        ] {
            for height in 1..12 {
                let layout = Layout {
                    sticky_headers,
                    ..Layout::default()
                };
                let mut forest = forest();
                forest.laid_out_to(layout.clone());
                forest.fit(height);
                for _ in 0..50 {
                    let rows = visible_rows(&forest, &layout, height);
                    assert!(rows.len() <= height);
                    assert!(rows.iter().any(|row| row.at.is_some()));
                    for (row, expected) in rows.iter().enumerate() {
                        assert_eq!(
                            forest_line_at(
                                Rect::new(0, 7, 40, height as u16),
                                &forest,
                                &layout,
                                7 + row as u16
                            ),
                            expected.at
                        );
                        if let Some(at) = expected.at.filter(|_| expected.dots) {
                            assert!(matches!(forest.lines()[at].content, Content::Project(_)));
                        }
                    }
                    forest.scrolled(Notch::Down, 1);
                }
                forest.apply(Action::Move(Motion::LastRow));
                assert!(
                    visible_rows(&forest, &layout, height)
                        .iter()
                        .any(|row| row.at == Some(forest.selected_line())),
                    "{sticky_headers:?} height {height}"
                );
            }
        }
    }

    #[test]
    fn root_indentation_removal_aligns_the_marker_and_preserves_nested_connectors() {
        let forest = forest();
        let layout = Layout {
            root_indent: RootIndent::Always,
            ..Layout::default()
        };
        let lines: Vec<_> = forest
            .lines()
            .viewport(0, 4)
            .map(|(_, line)| line)
            .collect();
        let row = Painted::of(
            fitted(lines[1], forest.lines().widths(), &layout, &at_rest()),
            80,
            1,
        )
        .rows()
        .remove(0);
        assert!(row.starts_with("[~]"), "{row}");
        let child = Painted::of(
            fitted(lines[2], forest.lines().widths(), &layout, &at_rest()),
            80,
            1,
        )
        .rows()
        .remove(0);
        assert_eq!(child.chars().nth(1), Some('├'), "{child}");
    }

    #[test]
    fn collapsed_roots_have_a_hint_after_the_status_without_a_left_column() {
        for ascii in [false, true] {
            let mut forest = forest();
            let layout = Layout {
                ascii,
                root_indent: RootIndent::Always,
                ..Layout::default()
            };
            forest.laid_out_to(layout.clone());
            let mut line = forest.lines().viewport(1, 1).next().unwrap().1.clone();
            let Content::Bead(_) = &line.content else {
                panic!("expected bead")
            };
            line.folded = Some(false);
            let closed = Painted::of(
                fitted(&line, forest.lines().widths(), &layout, &at_rest()),
                80,
                1,
            )
            .rows()
            .remove(0);
            assert!(
                closed.starts_with(if ascii { "[~]> " } else { "[~]▸ " }),
                "{closed}"
            );
            line.folded = Some(true);
            let open = Painted::of(
                fitted(&line, forest.lines().widths(), &layout, &at_rest()),
                80,
                1,
            )
            .rows()
            .remove(0);
            assert!(open.starts_with("[~] "));
            assert_eq!(
                closed.find("lift").map(|at| closed[..at].chars().count()),
                open.find("lift").map(|at| open[..at].chars().count()),
                "titles stay aligned"
            );
            assert!(!open.contains(if ascii { ">" } else { "▸" }));
            let project = forest.lines().viewport(0, 1).next().unwrap().1;
            let heading = Painted::of(
                fitted(project, forest.lines().widths(), &layout, &at_rest()),
                80,
                1,
            )
            .rows()
            .remove(0);
            assert!(
                heading.starts_with(if ascii { " v " } else { " ▾ " }),
                "{heading}"
            );
        }
    }

    #[test]
    fn nested_collapsed_beads_keep_their_branch_arrow_and_title_column() {
        for ascii in [false, true] {
            for indent in [2, 3, 4] {
                let mut forest = forest();
                let layout = Layout {
                    ascii,
                    indent,
                    ..Layout::default()
                };
                forest.laid_out_to(layout.clone());
                let mut line = forest.lines().viewport(1, 1).next().unwrap().1.clone();
                let mut rows = Vec::new();
                for open in [false, true] {
                    line.folded = Some(open);
                    line.prefix = lines::prefix_for_layout(&[], false, !open, None, &layout);
                    rows.push(
                        Painted::of(
                            fitted(&line, forest.lines().widths(), &layout, &at_rest()),
                            80,
                            1,
                        )
                        .rows()
                        .remove(0),
                    );
                }
                let arrow = if ascii { '>' } else { '▸' };
                assert!(
                    rows[0].find(arrow).unwrap() < rows[0].find('[').unwrap(),
                    "{}",
                    rows[0]
                );
                assert!(!rows[1].contains(arrow));
                assert_eq!(rows[0].find("lift"), rows[1].find("lift"));
            }
        }
    }

    #[test]
    fn root_indent_policy_covers_groups_panes_and_other_project_rows() {
        use crate::view::lines::{Group, GroupKind, Item};
        for ascii in [false, true] {
            for indent in [1, 2, 3, 16] {
                for (mode, projects, hidden) in [
                    (RootIndent::Never, 1, false),
                    (RootIndent::Always, 1, true),
                    (RootIndent::Always, 2, true),
                    (RootIndent::SingleTree, 1, true),
                    (RootIndent::SingleTree, 2, false),
                ] {
                    let layout = resolved_layout(
                        &Layout {
                            root_indent: mode,
                            ascii,
                            indent,
                            ..Layout::default()
                        },
                        projects,
                    );
                    for kind in [GroupKind::HiddenTrees, GroupKind::Unattributed] {
                        for open in [false, true] {
                            let line = lines::Line {
                                prefix: lines::prefix_for_layout(&[], true, !open, None, &layout),
                                depth: 1,
                                folded: Some(open),
                                place: None,
                                content: Content::Group(Group {
                                    kind,
                                    project: Some("summit-works".into()),
                                    count: 3,
                                    with_findings: 0,
                                }),
                            };
                            let text = Painted::of(
                                fitted(&line, &Widths::default(), &layout, &at_rest()),
                                100,
                                1,
                            )
                            .rows()
                            .remove(0);
                            if hidden {
                                assert!(
                                    text.starts_with(&format!(
                                        " {}",
                                        lines::marker_with(open, ascii).trim_end()
                                    )),
                                    "{mode:?}: {text}"
                                );
                            } else {
                                assert!(text.starts_with("  "), "{mode:?}: {text}");
                            }
                        }
                    }
                    let prefix = lines::prefix_for_layout(&[false], true, false, None, &layout);
                    for content in [
                        Content::Item(Item::Loose(pane("w:p2", PaneStatus::Working))),
                        Content::Note(Note::Cycle(1)),
                        Content::Elided {
                            count: 3,
                            under: lines::Place::root(lines::root_key(&grove(1))),
                        },
                    ] {
                        let line = lines::Line {
                            prefix: prefix.clone(),
                            depth: 2,
                            folded: None,
                            place: None,
                            content,
                        };
                        let text = Painted::of(
                            fitted(&line, &Widths::default(), &layout, &at_rest()),
                            100,
                            1,
                        )
                        .rows()
                        .remove(0);
                        let branch = if ascii { '+' } else { '└' };
                        assert_eq!(
                            text.find(branch).map(|at| text[..at].chars().count()),
                            Some(if hidden {
                                1
                            } else {
                                2 + usize::from(indent) + 1
                            }),
                            "{mode:?}: {text}"
                        );
                    }
                    let global = lines::Line {
                        prefix: "  + ".into(),
                        depth: 1,
                        folded: None,
                        place: None,
                        content: Content::Item(Item::Unconfigured(
                            crate::model::snapshot::UnconfiguredPane {
                                pane: pane("w:p3", PaneStatus::Idle).pane,
                                cwd: "/srv/invented/elsewhere".into(),
                                pane_status: PaneStatus::Idle,
                            },
                        )),
                    };
                    let text = Painted::of(
                        fitted(&global, &Widths::default(), &layout, &at_rest()),
                        100,
                        1,
                    )
                    .rows()
                    .remove(0);
                    assert!(
                        text.starts_with("  + "),
                        "global group child must retain its own indentation: {text}"
                    );
                }
            }
        }
    }

    #[test]
    fn preview_minimum_and_legend_leave_a_tree_row_on_tiny_terminals() {
        let layout = Layout {
            preview_min_height: 12,
            ..Layout::default()
        };
        for height in 1..40 {
            let area = Rect::new(0, 0, 40, height);
            let bands = regions_for_layout(area, 100, TailBand::Shown, &layout);
            assert!(bands.forest.height >= 1);
            assert!(bands.tail.bottom() <= area.bottom());
            if height >= 16 {
                assert!(bands.tail.height >= 13);
            }
            if height >= 3 && bands.forest.height > 1 {
                assert_eq!(bands.forest.bottom() + 1, bands.tail.y);
            }
        }
    }
}
