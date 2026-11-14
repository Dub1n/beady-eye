//! In-memory observations, not a reconstruction of task execution history.
//!
//! Integrate with `mod history` in `omo` and call `History::observe` after
//! conflict resolution. No clock, I/O, liveness inference or acceptance proof
//! lives here. Missing/invalid rows do not erase observations. Eviction does.
use super::{Activity, ActivityState};
use chrono::{DateTime, Utc};
use std::collections::{BTreeMap, VecDeque};

/// Project and full bead ID; neither component may be abbreviated.
pub type BeadKey = (String, String);

/// One actually seen worker state. Source timestamps remain in `activity`;
/// these two timestamps are collection times supplied by the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    /// A leaf worker, with no nested workers or unbounded evidence payload.
    pub activity: Activity,
    pub first_seen: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BeadHistory {
    /// Earlier entries retain their own attempt IDs. Never relabel them current.
    pub current_attempt: String,
    /// Oldest transition first; repeats update last_seen without adding entries.
    pub observations: VecDeque<Observation>,
    pub last_seen: DateTime<Utc>,
}

/// Hard bounds include current and earlier attempts together: at most 256
/// beads and 64 worker transitions per bead. Least recently observed bead is
/// evicted first, with the full key breaking ties deterministically.
#[derive(Debug, Default)]
pub struct History {
    beads: BTreeMap<BeadKey, BeadHistory>,
}

impl History {
    pub const MAX_BEADS: usize = 256;
    pub const MAX_OBSERVATIONS: usize = 64;

    pub fn beads(&self) -> &BTreeMap<BeadKey, BeadHistory> {
        &self.beads
    }

    /// Observe a resolved snapshot at `now`. Call with collection time, never
    /// task start/update time. Equal or older collection times are ignored per
    /// bead. Unknown/conflicting parents are ignored as a whole; invalid leaves
    /// are skipped individually. Working requires positive freshness; terminal
    /// records may have no freshness flag, matching Activity's reader contract.
    /// Previously seen earlier attempts cannot become current again while
    /// retained. After eviction, forgotten history cannot be recovered.
    pub fn observe(&mut self, activities: &BTreeMap<BeadKey, Activity>, now: DateTime<Utc>) {
        for (key, parent) in activities {
            if key.0 != parent.project || key.1 != parent.bead_id || !valid(parent) {
                continue;
            }
            let attempt = parent.attempt_id.as_deref().unwrap();
            if let Some(previous) = self.beads.get(key) {
                if now <= previous.last_seen
                    || (previous.current_attempt != attempt
                        && previous
                            .observations
                            .iter()
                            .any(|o| o.activity.attempt_id.as_deref() == Some(attempt)))
                {
                    continue;
                }
            }
            let leaves = if parent.workers.is_empty() {
                std::slice::from_ref(parent)
            } else {
                &parent.workers
            };
            // Repeated task identities are ambiguous, even if their states agree.
            let mut candidates = BTreeMap::<&str, Option<&Activity>>::new();
            for leaf in leaves {
                if !valid(leaf)
                    || !leaf.workers.is_empty()
                    || leaf.project != key.0
                    || leaf.bead_id != key.1
                    || leaf.attempt_id != parent.attempt_id
                {
                    continue;
                }
                if let Some(task) = leaf.task_id.as_deref().filter(|id| !id.is_empty()) {
                    candidates
                        .entry(task)
                        .and_modify(|value| *value = None)
                        .or_insert(Some(leaf));
                }
            }
            let mut accepted = false;
            for leaf in candidates.values().flatten() {
                let previous = self.beads.get(key).and_then(|bead| {
                    bead.observations.iter().rev().find(|o| {
                        o.activity.attempt_id == leaf.attempt_id
                            && o.activity.task_id == leaf.task_id
                    })
                });
                if previous.is_some_and(|o| {
                    matches!((leaf.observed_at, o.activity.observed_at), (Some(new), Some(old)) if new < old)
                        || (leaf.observed_at.is_some() && leaf.observed_at == o.activity.observed_at && leaf.state != o.activity.state)
                }) {
                    continue;
                }
                let bead = self
                    .beads
                    .entry(key.clone())
                    .or_insert_with(|| BeadHistory {
                        current_attempt: attempt.to_owned(),
                        observations: VecDeque::new(),
                        last_seen: now,
                    });
                bead.current_attempt = attempt.to_owned();
                bead.last_seen = now;
                accepted = true;
                if let Some(previous) = bead.observations.iter_mut().rev().find(|o| {
                    o.activity.attempt_id == leaf.attempt_id && o.activity.task_id == leaf.task_id
                }) {
                    if previous.activity.state == leaf.state {
                        previous.last_seen = now;
                        previous.activity = compact(leaf);
                        continue;
                    }
                }
                bead.observations.push_back(Observation {
                    activity: compact(leaf),
                    first_seen: now,
                    last_seen: now,
                });
                while bead.observations.len() > Self::MAX_OBSERVATIONS {
                    bead.observations.pop_front();
                }
            }
            if accepted && self.beads.len() > Self::MAX_BEADS {
                let oldest = self
                    .beads
                    .iter()
                    .min_by_key(|(key, bead)| (bead.last_seen, *key))
                    .map(|(key, _)| key.clone())
                    .unwrap();
                self.beads.remove(&oldest);
            }
        }
    }
}

fn valid(activity: &Activity) -> bool {
    activity
        .attempt_id
        .as_deref()
        .is_some_and(|id| !id.is_empty())
        && !matches!(
            activity.state,
            ActivityState::Unknown | ActivityState::Conflict
        )
        && activity.fresh != Some(false)
        && (activity.state != ActivityState::Working || activity.fresh == Some(true))
}

fn compact(activity: &Activity) -> Activity {
    let mut result = activity.clone();
    result.workers.clear();
    result.evidence.clear();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time(n: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(n, 0).unwrap()
    }
    fn worker(attempt: &str, task: &str, state: ActivityState, n: i64) -> Activity {
        Activity {
            state,
            project: "orchard".into(),
            bead_id: "fruit-1".into(),
            attempt_id: Some(attempt.into()),
            task_id: Some(task.into()),
            worker_name: None,
            worker_type: None,
            effective_model: None,
            child_session: None,
            coordinator: None,
            coordinator_model: None,
            observed_at: Some(time(n)),
            fresh: Some(true),
            acceptance_ready: false,
            evidence: vec![],
            workers: vec![],
        }
    }
    fn feed(history: &mut History, activity: Activity, n: i64) {
        history.observe(
            &BTreeMap::from([(
                (activity.project.clone(), activity.bead_id.clone()),
                activity,
            )]),
            time(n),
        );
    }
    fn bead(history: &History) -> &BeadHistory {
        history.beads.values().next().unwrap()
    }

    #[test]
    fn only_observed_states_and_times_survive_attempt_changes() {
        let mut h = History::default();
        feed(&mut h, worker("a", "one", ActivityState::Finished, 1), 10);
        feed(&mut h, worker("a", "one", ActivityState::Finished, 2), 20);
        assert_eq!(bead(&h).observations.len(), 1);
        assert_eq!(bead(&h).observations[0].first_seen, time(10));
        assert_eq!(bead(&h).observations[0].last_seen, time(20));
        feed(&mut h, worker("b", "one", ActivityState::Working, 3), 30);
        feed(&mut h, worker("a", "one", ActivityState::Failed, 4), 40);
        assert_eq!(bead(&h).current_attempt, "b");
        assert_eq!(bead(&h).observations.len(), 2);
        assert_eq!(
            bead(&h).observations[0].activity.state,
            ActivityState::Finished
        );
    }

    #[test]
    fn invalid_stale_reordered_and_ambiguous_evidence_changes_nothing() {
        let mut h = History::default();
        let original = worker("a", "one", ActivityState::Working, 10);
        feed(&mut h, original.clone(), 20);
        let expected = h.beads.clone();
        for state in [ActivityState::Unknown, ActivityState::Conflict] {
            feed(&mut h, worker("b", "two", state, 30), 40);
        }
        let mut stale = original.clone();
        stale.fresh = Some(false);
        feed(&mut h, stale, 40);
        feed(&mut h, worker("a", "one", ActivityState::Failed, 9), 40);
        feed(&mut h, worker("a", "one", ActivityState::Failed, 10), 40);
        feed(&mut h, worker("b", "one", ActivityState::Finished, 30), 19);
        let mut duplicate = original.clone();
        duplicate.workers = vec![original.clone(), original];
        feed(&mut h, duplicate, 40);
        assert_eq!(h.beads, expected);
    }

    #[test]
    fn workers_projects_and_absent_rows_are_independent() {
        let mut h = History::default();
        let one = worker("a", "one", ActivityState::Working, 1);
        let two = worker("a", "two", ActivityState::Finished, 1);
        let mut parent = one.clone();
        parent.workers = vec![one, two];
        feed(&mut h, parent.clone(), 10);
        parent.project = "meadow".into();
        parent
            .workers
            .iter_mut()
            .for_each(|w| w.project = "meadow".into());
        feed(&mut h, parent, 20);
        h.observe(&BTreeMap::new(), time(30));
        assert_eq!(h.beads.len(), 2);
        assert!(h.beads.values().all(|b| b.observations.len() == 2));
    }

    #[test]
    fn terminal_without_source_time_is_observed_without_backdating() {
        let mut h = History::default();
        let mut w = worker("a", "one", ActivityState::Finished, 1);
        w.observed_at = None;
        w.fresh = None;
        feed(&mut h, w.clone(), 10);
        w.state = ActivityState::AwaitingAcceptance;
        feed(&mut h, w, 20);
        assert_eq!(bead(&h).observations.len(), 2);
        assert_eq!(bead(&h).observations[1].first_seen, time(20));
        assert_eq!(bead(&h).observations[1].activity.observed_at, None);
    }

    #[test]
    fn mismatched_identity_and_attempt_never_enter_history() {
        let mut h = History::default();
        let mut parent = worker("a", "one", ActivityState::Working, 1);
        let mut other = parent.clone();
        other.attempt_id = Some("earlier".into());
        parent.workers = vec![other];
        feed(&mut h, parent, 10);
        let mut missing = worker("a", "one", ActivityState::Finished, 1);
        missing.task_id = None;
        feed(&mut h, missing, 10);
        h.observe(
            &BTreeMap::from([(
                ("wrong".into(), "fruit-1".into()),
                worker("a", "one", ActivityState::Working, 1),
            )]),
            time(10),
        );
        assert!(h.beads.is_empty());
    }

    #[test]
    fn bounds_drop_oldest_transitions_and_least_recent_beads() {
        let mut h = History::default();
        for n in 1..=100 {
            let state = if n % 2 == 0 {
                ActivityState::Finished
            } else {
                ActivityState::Working
            };
            feed(&mut h, worker("a", "one", state, n), n);
        }
        assert_eq!(bead(&h).observations.len(), History::MAX_OBSERVATIONS);
        assert_eq!(bead(&h).observations[0].first_seen, time(37));
        for n in 0..300 {
            let mut w = worker("a", "one", ActivityState::Finished, 1);
            w.bead_id = format!("fruit-{n:04}");
            feed(&mut h, w, 200 + n);
        }
        assert_eq!(h.beads.len(), History::MAX_BEADS);
        assert!(!h
            .beads
            .contains_key(&("orchard".into(), "fruit-0000".into())));
    }
}
