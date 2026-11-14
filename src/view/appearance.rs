//! Compact, presentation-only choices for tree rows.
//!
//! Configuration belongs to the caller. These functions take their inputs
//! explicitly and keep no process-wide state.

use crate::collect::omo::{Activity, ActivityState};
use crate::model::types::Status;

/// Three ASCII characters for one bead's stored status and optional activity.
/// Open, hooked, blocked and closed keep their persistent meaning. Activity
/// evidence refines in-progress work; the row also retains its evidence for
/// details and shows conflict as a separate annotation.
pub fn marker(status: &Status, activity: Option<&Activity>) -> &'static str {
    match status {
        Status::Open => "[ ]",
        Status::Hooked => "[<]",
        Status::Blocked => "[?]",
        Status::Closed => "[x]",
        Status::InProgress => match activity
            .filter(|activity| {
                activity.fresh != Some(false) || activity.state == ActivityState::Conflict
            })
            .map(|activity| activity.state)
        {
            Some(ActivityState::Finished) => "[T]",
            Some(ActivityState::AwaitingAcceptance) => "[A]",
            Some(ActivityState::Failed) => "[F]",
            Some(ActivityState::Cancelled) => "[-]",
            Some(ActivityState::Conflict) => "[!]",
            Some(ActivityState::Working | ActivityState::Unknown) | None => "[~]",
        },
        Status::Deferred => "[S]",
        Status::Pinned => "[P]",
        Status::Other(_) => "[?]",
    }
}

/// Meaning of the selected row's displayed marker, independent of priority.
pub fn description(status: &Status, activity: Option<&Activity>) -> String {
    if let Status::Other(name) = status {
        return format!("[?]: unknown status ({name})");
    }
    let marker = marker(status, activity);
    let meaning = match marker {
        "[ ]" => "to-do",
        "[~]" => "in progress",
        "[<]" => "hooked",
        "[?]" => "blocked",
        "[T]" => "validation pending",
        "[A]" => "awaiting acceptance",
        "[F]" => "execution failed",
        "[-]" => "execution cancelled",
        "[x]" => "closed",
        "[!]" => "conflicting evidence",
        "[S]" => "deferred",
        "[P]" => "pinned",
        _ => "unknown status",
    };
    format!("{marker}: {meaning}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::{fitted::Fitted, lines};
    use ratatui::{buffer::Buffer, layout::Rect, text::Span, widgets::Widget};

    #[test]
    fn markers_are_three_ascii_characters_and_status_specific() {
        let statuses = [
            (Status::Open, "[ ]"),
            (Status::InProgress, "[~]"),
            (Status::Blocked, "[?]"),
            (Status::Closed, "[x]"),
            (Status::Deferred, "[S]"),
            (Status::Hooked, "[<]"),
            (Status::Pinned, "[P]"),
            (Status::Other("future".into()), "[?]"),
        ];
        for (status, expected) in statuses {
            let marker = marker(&status, None);
            assert_eq!(marker, expected);
            assert_eq!(marker.len(), 3);
            assert!(marker.is_ascii());
        }
    }

    #[test]
    fn activity_markers_use_the_agreed_three_character_vocabulary() {
        let cases = [
            (ActivityState::Working, "[~]"),
            (ActivityState::Finished, "[T]"),
            (ActivityState::AwaitingAcceptance, "[A]"),
            (ActivityState::Failed, "[F]"),
            (ActivityState::Cancelled, "[-]"),
            (ActivityState::Conflict, "[!]"),
            (ActivityState::Unknown, "[~]"),
        ];
        for (activity, expected) in cases {
            let activity = Activity {
                state: activity,
                project: String::new(),
                bead_id: String::new(),
                attempt_id: None,
                task_id: None,
                worker_name: None,
                worker_type: None,
                effective_model: None,
                child_session: None,
                coordinator: None,
                coordinator_model: None,
                observed_at: None,
                fresh: None,
                acceptance_ready: false,
                evidence: Vec::new(),
                workers: Vec::new(),
            };
            assert_eq!(marker(&Status::InProgress, Some(&activity)), expected);
            assert_eq!(expected.len(), 3);
            assert!(expected.is_ascii());
        }
        assert_eq!(marker(&Status::Hooked, None), "[<]");
        assert_eq!(marker(&Status::Blocked, None), "[?]");
        assert_eq!(marker(&Status::Closed, None), "[x]");
        assert_eq!(marker(&Status::Pinned, None), "[P]");
        let finished = Activity {
            state: ActivityState::Finished,
            project: String::new(),
            bead_id: String::new(),
            attempt_id: None,
            task_id: None,
            worker_name: None,
            worker_type: None,
            effective_model: None,
            child_session: None,
            coordinator: None,
            coordinator_model: None,
            observed_at: None,
            fresh: None,
            acceptance_ready: false,
            evidence: Vec::new(),
            workers: Vec::new(),
        };
        assert_eq!(marker(&Status::Open, Some(&finished)), "[ ]");
        assert_eq!(marker(&Status::Hooked, Some(&finished)), "[<]");
        assert_eq!(marker(&Status::Blocked, Some(&finished)), "[?]");
        assert_eq!(marker(&Status::Closed, Some(&finished)), "[x]");
        let stale = Activity {
            state: ActivityState::Working,
            fresh: Some(false),
            ..finished
        };
        assert_eq!(marker(&Status::InProgress, Some(&stale)), "[~]");
    }

    #[test]
    fn selected_status_explains_the_displayed_marker_without_claiming_verification() {
        assert_eq!(description(&Status::InProgress, None), "[~]: in progress");
        assert_eq!(description(&Status::Closed, None), "[x]: closed");
        assert_eq!(description(&Status::Blocked, None), "[?]: blocked");
        assert_eq!(
            description(&Status::Other("new-state".into()), None),
            "[?]: unknown status (new-state)"
        );
        for (state, expected) in [
            (ActivityState::Finished, "[T]: validation pending"),
            (
                ActivityState::AwaitingAcceptance,
                "[A]: awaiting acceptance",
            ),
            (ActivityState::Conflict, "[!]: conflicting evidence"),
        ] {
            let activity = Activity {
                state,
                project: String::new(),
                bead_id: String::new(),
                attempt_id: None,
                task_id: None,
                worker_name: None,
                worker_type: None,
                effective_model: None,
                child_session: None,
                coordinator: None,
                coordinator_model: None,
                observed_at: None,
                fresh: None,
                acceptance_ready: false,
                evidence: vec![],
                workers: vec![],
            };
            assert_eq!(description(&Status::InProgress, Some(&activity)), expected);
            assert_eq!(description(&Status::Closed, Some(&activity)), "[x]: closed");
        }
    }

    #[test]
    fn compact_fold_markers_keep_the_branch_and_column_alignment() {
        for ascii in [false, true] {
            for indent in [1, 2, 3, 4] {
                for last in [false, true] {
                    let open = lines::prefix_with(&[true], last, false, None, indent, ascii);
                    let shut = lines::prefix_with(&[true], last, true, None, indent, ascii);
                    assert_eq!(open.chars().count(), shut.chars().count());
                    let branch = if ascii {
                        '+'
                    } else if last {
                        '└'
                    } else {
                        '├'
                    };
                    assert!(shut.contains(branch), "{shut:?}");
                }
            }
        }
    }

    #[test]
    fn compact_rows_fit_narrow_widths_and_deep_tree_prefixes() {
        for width in [30, 40, 60, 80] {
            let row = Fitted::new(
                vec![
                    Span::raw(lines::prefix_with(&[true; 20], true, false, None, 2, false)),
                    Span::raw(marker(&Status::InProgress, None)),
                ],
                vec![Span::raw("title 東京 🧵 remains visible")],
                vec![Span::raw("optional state that yields first")],
            )
            .compact_tree(2);
            let mut buffer = Buffer::empty(Rect::new(0, 0, width, 1));
            row.render(Rect::new(0, 0, width, 1), &mut buffer);
            let line: String = (0..width).map(|x| buffer[(x, 0)].symbol()).collect();
            assert!(line.chars().count() >= width as usize);
            assert!(line.contains("[~]"), "width={width}: {line:?}");
            assert!(line.contains("title"), "width={width}: {line:?}");
        }
    }

    #[test]
    fn ascii_prefix_is_explicit_and_unicode_remains_the_default() {
        let unicode = lines::prefix(&[true, false], true, false, None);
        let ascii = lines::prefix_with(&[true, false], true, false, None, 2, true);
        assert!(unicode.contains('│'));
        assert!(unicode.contains('└'));
        assert!(ascii.contains('|'));
        assert!(ascii.contains('+'));
        assert!(!ascii.chars().any(|ch| "│└├─┄".contains(ch)));
        assert_eq!(
            lines::prefix_with(&[true], true, false, None, 2, true).len(),
            6
        );
        let upward =
            lines::upward_prefix_with(&[], true, &crate::model::types::Edge::Blocks, 2, true);
        assert!(upward.is_ascii());
        assert!(upward.contains('^'));
        assert_eq!(lines::marker_with(false, true), "> ");
    }
}
