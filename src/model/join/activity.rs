//! Exact, non-exclusive native session associations over the generic pane join.
use super::*;
use crate::collect::omo::{Activity, ActivityState};

/// Add live native owners after current-attempt validation. Terminal activity
/// and workflow execution remain independent facts; neither rewrites the other.
pub fn connect_activity(
    joined: &mut Joined,
    activities: &mut BTreeMap<(String, String), Activity>,
    rows: &[ProjectRows<'_>],
    panes: &[Pane],
    cfg: &Config,
) {
    let eligible: BTreeSet<_> = rows
        .iter()
        .flat_map(|rows| {
            rows.rows
                .iter()
                .filter(|bead| !bead.status.is_finished())
                .map(|bead| (rows.project.to_owned(), bead.id.clone()))
        })
        .collect();
    let mut live = BTreeMap::<&str, Vec<&Pane>>::new();
    for pane in panes {
        if let Some(session) = pane.live_agent_session() {
            live.entry(session).or_default().push(pane);
        }
    }
    for (key, activity) in activities {
        if !eligible.contains(key)
            || activity.attempt_id.is_none()
            || activity.state == ActivityState::Conflict
        {
            continue;
        }
        let bead = BeadKey {
            project: key.0.clone(),
            id: key.1.clone(),
        };
        if joined.refused.contains_key(&bead) {
            continue;
        }
        let mut candidates = Vec::new();
        let workers: Vec<_> = if activity.workers.is_empty() {
            vec![&*activity]
        } else {
            activity.workers.iter().collect()
        };
        for worker in workers {
            if worker.state == ActivityState::Conflict {
                continue;
            }
            let worker_session = worker.child_session.as_deref().or_else(|| {
                (worker.worker_type.as_deref() == Some("direct"))
                    .then_some(worker.coordinator.as_deref())
                    .flatten()
            });
            if let Some(session) = worker_session {
                candidates.push((session.to_owned(), JoinSource::NativeWorker));
            }
        }
        if let Some(session) = &activity.coordinator {
            candidates.push((session.clone(), JoinSource::NativeCoordinator));
        }
        let mut linked = Vec::new();
        let mut seen = BTreeSet::new();
        for (session, source) in candidates {
            if !seen.insert(session.clone()) {
                continue;
            }
            let Some(matches) = live.get(session.as_str()) else {
                continue;
            };
            let [pane] = matches.as_slice() else {
                activity.evidence.push(format!("live session {session} is ambiguous across {} panes; no native association chosen", matches.len()));
                continue;
            };
            if project_of(pane, &cfg.projects).map(|p| p.name.as_str()) != Some(key.0.as_str()) {
                activity.evidence.push(format!(
                    "live session {session} is in another project; no native association chosen"
                ));
                continue;
            }
            let role = if source == JoinSource::NativeCoordinator {
                "coordinator"
            } else {
                "worker/direct"
            };
            let provenance = pane
                .agent_session
                .as_ref()
                .map(|s| s.source.as_str())
                .unwrap_or("provider");
            activity.evidence.push(format!("live {role}: pane {}/{}; session {session}; terminal {:?}; identity source {provenance}. Terminal activity is not per-bead execution or acceptance proof", pane.session, pane.pane_id, pane.agent_status));
            linked.push(agent_ref(pane, source));
        }
        if let Some(primary) = linked.first() {
            if primary.source == JoinSource::NativeWorker
                && joined.agents.get(&bead).is_some_and(|old| {
                    old.pane != primary.pane && old.source != JoinSource::DisplayAgent
                })
            {
                activity.state = ActivityState::Conflict;
                activity.evidence.push("native worker pane conflicts with the explicit bead/pane join; existing association retained".into());
                continue;
            }
            // Explicit Beads joins keep priority. Native coordinator links are
            // additional associations, not a competing exclusive claim.
            if primary.source == JoinSource::NativeWorker
                && joined
                    .agents
                    .get(&bead)
                    .is_some_and(|old| old.source == JoinSource::DisplayAgent)
            {
                joined.agents.insert(bead, primary.clone());
                activity.evidence.push(
                    "exact native worker identity supersedes free-text pane-caption inference"
                        .into(),
                );
            } else {
                joined.agents.entry(bead).or_insert_with(|| primary.clone());
            }
        }
        joined
            .linked_panes
            .extend(linked.into_iter().map(|agent| agent.pane));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collect::{
        bd::parse_shared_beads,
        omo::{BeadInput, OmoConfig, Reader},
    };
    use crate::model::types::AgentSession;

    fn config() -> Config {
        Config::from_toml("[[projects]]\nname='arkham'\npath='/srv/arkham'\n[[projects]]\nname='dunwich'\npath='/srv/dunwich'\n").unwrap()
    }
    fn pane(id: &str, session: &str) -> Pane {
        let mut pane = Pane::answered(
            "default".into(),
            id.into(),
            "/srv/arkham".into(),
            PaneStatus::Working,
        );
        pane.agent = Some("pi".into());
        pane.agent_session = Some(AgentSession {
            agent: "pi".into(),
            kind: "id".into(),
            source: "invented".into(),
            value: session.into(),
        });
        pane
    }
    type Activities = BTreeMap<(String, String), Activity>;
    fn ground() -> (Vec<Arc<Bead>>, Activities) {
        let beads = parse_shared_beads(&serde_json::json!([
            {"id":"ark-1","title":"Gateway","status":"in_progress","metadata":{"qrclipWork":{"attempt":{"id":"attempt-a","coordinator":"owner-a","mode":"direct"}}}},
            {"id":"ark-2","title":"Search","status":"in_progress","metadata":{"qrclipWork":{"attempt":{"id":"attempt-b","coordinator":"owner-a","mode":"delegate"}}}}
        ]).to_string()).unwrap();
        let mut reader = Reader::new(OmoConfig {
            task_directory: "/not-present-invented/tasks".into(),
            ..OmoConfig::default()
        });
        let batch = reader.collect(
            &beads
                .iter()
                .map(|b| BeadInput::from_bead("arkham", b))
                .collect::<Vec<_>>(),
        );
        (beads, batch.activities)
    }
    #[test]
    fn one_live_session_owns_multiple_beads_without_claiming_worker_execution() {
        let (beads, mut activities) = ground();
        let panes = vec![pane("w:p1", "owner-a")];
        let mut joined = Joined::default();
        connect_activity(
            &mut joined,
            &mut activities,
            &[ProjectRows {
                project: "arkham",
                rows: &beads,
            }],
            &panes,
            &config(),
        );
        assert_eq!(joined.agents.len(), 2);
        assert_eq!(
            joined.agents[&BeadKey {
                project: "arkham".into(),
                id: "ark-1".into()
            }]
                .source,
            JoinSource::NativeWorker
        );
        assert_eq!(
            joined.agents[&BeadKey {
                project: "arkham".into(),
                id: "ark-2".into()
            }]
                .source,
            JoinSource::NativeCoordinator
        );
        assert!(activities
            .values()
            .all(|a| a.state == ActivityState::Unknown && !a.acceptance_ready));
        assert!(unattributed(&panes, &joined).is_empty());
    }
    #[test]
    fn missing_ambiguous_wrong_project_conflicting_and_closed_owners_do_not_gain_a_live_join() {
        for case in [
            "missing",
            "ambiguous",
            "project",
            "conflict",
            "closed",
            "attempt",
            "old-session",
        ] {
            let (mut beads, mut activities) = ground();
            let mut panes = vec![pane("w:p1", "owner-a")];
            match case {
                "missing" => panes.clear(),
                "old-session" => {
                    panes[0].agent_session.as_mut().unwrap().value = "previous-owner".into()
                }
                "ambiguous" => panes.push(pane("w:p2", "owner-a")),
                "project" => panes[0].cwd = "/srv/dunwich".into(),
                "conflict" => activities
                    .values_mut()
                    .for_each(|a| a.state = ActivityState::Conflict),
                "closed" => beads
                    .iter_mut()
                    .for_each(|b| Arc::make_mut(b).status = crate::model::types::Status::Closed),
                "attempt" => activities.values_mut().for_each(|a| a.attempt_id = None),
                _ => unreachable!(),
            }
            let mut joined = Joined::default();
            connect_activity(
                &mut joined,
                &mut activities,
                &[ProjectRows {
                    project: "arkham",
                    rows: &beads,
                }],
                &panes,
                &config(),
            );
            assert!(joined.agents.is_empty(), "{case}");
        }
    }
    #[test]
    fn a_live_worker_wins_preview_over_the_coordinator_but_both_links_are_visible() {
        let (beads, mut activities) = ground();
        let a = activities
            .get_mut(&("arkham".into(), "ark-2".into()))
            .unwrap();
        a.child_session = Some("worker-b".into());
        a.state = ActivityState::Finished;
        let panes = vec![pane("w:p1", "owner-a"), pane("w:p2", "worker-b")];
        let mut joined = Joined::default();
        connect_activity(
            &mut joined,
            &mut activities,
            &[ProjectRows {
                project: "arkham",
                rows: &beads,
            }],
            &panes,
            &config(),
        );
        let a = &activities[&("arkham".into(), "ark-2".into())];
        assert_eq!(
            a.state,
            ActivityState::Finished,
            "live terminal must not rewrite native completion"
        );
        assert_eq!(
            joined.agents[&BeadKey {
                project: "arkham".into(),
                id: "ark-2".into()
            }]
                .pane
                .id,
            "w:p2"
        );
        assert!(a.evidence.iter().any(|e| e.contains("live coordinator")));
        assert!(a.evidence.iter().any(|e| e.contains("live worker/direct")));
        assert_eq!(joined.linked_panes.len(), 2);
    }
    #[test]
    fn native_worker_disagreement_preserves_the_existing_join_and_requires_attention() {
        let (beads, mut activities) = ground();
        let panes = vec![pane("w:p1", "owner-a")];
        let key = BeadKey {
            project: "arkham".into(),
            id: "ark-1".into(),
        };
        let original = agent_ref(&pane("w:other", "other-owner"), JoinSource::AgentPane);
        let mut joined = Joined::default();
        joined.agents.insert(key.clone(), original.clone());
        connect_activity(
            &mut joined,
            &mut activities,
            &[ProjectRows {
                project: "arkham",
                rows: &beads,
            }],
            &panes,
            &config(),
        );
        assert_eq!(joined.agents[&key], original);
        assert_eq!(
            activities[&("arkham".into(), "ark-1".into())].state,
            ActivityState::Conflict
        );
    }
    #[test]
    fn exact_native_worker_identity_takes_priority_over_caption_inference() {
        let (beads, mut activities) = ground();
        let panes = vec![pane("w:p1", "owner-a")];
        let key = BeadKey {
            project: "arkham".into(),
            id: "ark-1".into(),
        };
        let mut joined = Joined::default();
        joined.agents.insert(
            key.clone(),
            agent_ref(
                &pane("w:caption", "another-owner"),
                JoinSource::DisplayAgent,
            ),
        );
        connect_activity(
            &mut joined,
            &mut activities,
            &[ProjectRows {
                project: "arkham",
                rows: &beads,
            }],
            &panes,
            &config(),
        );
        assert_eq!(joined.agents[&key].pane.id, "w:p1");
        assert_eq!(joined.agents[&key].source, JoinSource::NativeWorker);
        assert_eq!(
            activities[&("arkham".into(), "ark-1".into())].state,
            ActivityState::Unknown
        );
    }
}
