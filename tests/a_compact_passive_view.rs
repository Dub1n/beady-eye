//! A real terminal loop over invented Beads and OmO records at sidebar widths.
mod terminal;
use std::time::Duration;
use terminal::driver::{Driven, GIVING_UP};
use terminal::shims::ShimmedTracker;
use terminal::{a_home_naming_one_project_settled, ENTER_ALTERNATE_SCREEN};

#[test]
fn active_headless_worker_counts_without_an_observer() {
    use serde_json::json;
    use std::fs;
    let home = a_home_naming_one_project_settled("legacy-live-tree", "");
    let tasks = home.join("native-tasks");
    fs::create_dir(&tasks).unwrap();
    let cfg = home.join(".config/beady-eye/config.toml");
    let mut config = fs::read_to_string(&cfg).unwrap();
    config.push_str(&format!(
        "\n[omo.arkham]\ntask_directory='{}'\n",
        tasks.display()
    ));
    fs::write(cfg, config).unwrap();
    let tracker = ShimmedTracker::beside(&home);
    tracker.holds(&json!([{
        "id":"ark-legacy","title":"Inventory","status":"in_progress","priority":2,"issue_type":"task",
        "metadata":{"qrclipWork":{"attempt":{"id":"attempt-a","coordinator":"owner-a","mode":"delegate"}},
                    "qrclipDispatch":{"attemptId":"attempt-a","taskId":"st_legacy","childSession":"child-a"}}
    }]).to_string());
    for (status, expected_count) in [("running", 1), ("completed", 0)] {
        fs::write(tasks.join("st_legacy.json"), json!({"task_id":"st_legacy","status":status,
            "parent_session_id":"owner-a","child_session_id":"child-a","updated_at":chrono::Utc::now()}).to_string()).unwrap();
        let result = terminal::bdi_on_pipes(&home)
            .args(["--all", "--json"])
            .envs(tracker.environment())
            .output()
            .unwrap();
        assert!(result.status.success(), "{:?}", result.stderr);
        let snapshot: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        let tree = &snapshot["trees"][0];
        assert_eq!(
            tree["nodes"][0]["agent_live"],
            expected_count == 1,
            "{status}"
        );
        assert_eq!(tree["counts"]["live_agents"], expected_count, "{status}");
    }
}

#[test]
fn compact_native_completion_is_visible_and_details_work_at_sidebar_widths() {
    for colour_brackets in [true, false] {
        for cols in [30, 40, 60, 80] {
            let settings = format!(
                "[row]\ncompact=true\nshow_ids=false\nindent=2\nascii=true\ncolour_brackets={colour_brackets}\n"
            );
            let home = a_home_naming_one_project_settled(
                &format!("compact-{cols}-{colour_brackets}"),
                &settings,
            );
            let tasks = home.join("native-tasks");
            std::fs::create_dir_all(&tasks).unwrap();
            let config_path = home.join(".config/beady-eye/config.toml");
            let mut config = std::fs::read_to_string(&config_path).unwrap();
            config.push_str(&format!(
                "\n[omo.arkham]\ntask_directory='{}'\n",
                tasks.display()
            ));
            std::fs::write(&config_path, config).unwrap();
            std::fs::write(
            tasks.join("st_invented.json"),
            serde_json::json!({
                "task_id":"st_invented","status":"completed","parent_session_id":"invented-owner",
                "child_session_id":"invented-child","name":"gateway-worker","agent_type":"reviewer",
                "effective_model":{"provider":"invented","model_id":"gpt-6.1-sol"},
                "updated_at":chrono::Utc::now().to_rfc3339()
            })
            .to_string(),
        )
        .unwrap();
            let tracker = ShimmedTracker::beside(&home);
            tracker.holds(&serde_json::json!([{
            "id":"ark-invented","title":"Gateway","status":"in_progress","priority":2,"issue_type":"task",
            "metadata":{"qrclipWork":{"attempt":{"id":"invented-attempt","coordinator":"invented-owner","mode":"delegate"}},
                "qrclipDispatch":{"attemptId":"invented-attempt","taskId":"st_invented","childSession":"invented-child","nativeStatus":"running"}}
        }]).to_string());
            let mut bdi = Driven::bdi(24, cols, home, &tracker.environment());
            bdi.read_until(ENTER_ALTERNATE_SCREEN, GIVING_UP);
            bdi.read_until(b"Sol", GIVING_UP);
            bdi.settle(Duration::from_millis(80), GIVING_UP);
            let repaint = bdi.resize(25, cols);
            let screen = bdi.answer_to(repaint, GIVING_UP);
            let text = terminal::rows_drawn(&screen).join("\n");
            assert!(
                text.contains("[T]") && text.contains("Gateway"),
                "width {cols}: {text}"
            );
            assert!(
                !text.contains(['▾', '▸', '├', '└', '│']),
                "ASCII tree connectors and fold markers at width {cols}: {text}"
            );
            assert!(
                !text.contains("ark-invented"),
                "tree IDs should be hidden: {text}"
            );
            let selected = bdi.send(b"j");
            bdi.answer_to(selected, GIVING_UP);
            let repaint = bdi.resize(24, cols);
            let screen = bdi.answer_to(repaint, GIVING_UP);
            let drawn = terminal::rows_drawn(&screen);
            let text = drawn.join("\n");
            let legend = drawn
                .iter()
                .position(|row| row.starts_with("[T]: validation pending"))
                .expect("selected status in bead band");
            let boundary = drawn.iter().position(|row| {
                row.contains("no pane") || row.contains("──") || row.contains("--")
            });
            assert!(
                boundary.is_some_and(|row| row > legend),
                "legend above preview at width {cols}: {text}"
            );
            let detail = bdi.send(b"\r");
            bdi.answer_to(detail, GIVING_UP);
            let repaint = bdi.resize(26, cols);
            let screen = bdi.answer_to(repaint, GIVING_UP);
            assert_eq!(
                terminal::window_over(&screen).as_deref(),
                Some("ark-invented"),
                "details retain full ID at width {cols}: {:?}",
                terminal::rows_drawn(&screen)
            );
            let back = bdi.send(b"\x1b");
            bdi.answer_to(back, GIVING_UP);
            let copy = bdi.send(b"y");
            let screen = bdi.answer_to(copy, GIVING_UP);
            assert!(
                terminal::contains(&screen, b"\x1b]52;"),
                "copy ID uses OSC52"
            );
            bdi.send(b"q");
        }
    }
}

#[test]
fn focused_tree_offers_activity_navigation_to_an_active_worker_outside_focus() {
    let home = a_home_naming_one_project_settled(
        "focused-tree-off-focus-activity",
        "[row]\ncompact=true\nshow_ids=false\nascii=true\n",
    );
    let tasks = home.join("native-tasks");
    let observations = home.join("observations");
    std::fs::create_dir_all(&tasks).unwrap();
    std::fs::create_dir_all(&observations).unwrap();
    let config_path = home.join(".config/beady-eye/config.toml");
    let mut config = std::fs::read_to_string(&config_path).unwrap();
    config.push_str(&format!(
        "\n[omo.arkham]\ntask_directory='{}'\nobservation_directory='{}'\n",
        tasks.display(),
        observations.display()
    ));
    std::fs::write(config_path, config).unwrap();

    let now = chrono::Utc::now();
    let created = "2026-01-01T00:00:00Z";
    std::fs::write(
        tasks.join("st_active_worker.json"),
        serde_json::json!({
            "task_id":"st_active_worker","created_at":created,"updated_at":now,
            "status":"running","parent_session_id":"invented-coordinator",
            "child_session_id":"invented-worker"
        })
        .to_string(),
    )
    .unwrap();
    let observation_path = observations.join("frame-focused-tree.json");
    let mut observation = serde_json::json!({
        "version":1,
        "scope":{"project":"arkham","taskDirectory":tasks},
        "epoch":"invented-epoch","sequence":1,"observedAt":now,
        "expiresAt":now + chrono::Duration::seconds(5),
        "admissions":[{
            "bead":"ark-worker","attempt":"invented-attempt",
            "toolCall":"invented-call","task":"st_active_worker",
            "parent":"invented-coordinator","created":created,
            "initialChild":null,"invalid":false
        }],
        "workers":[{
            "session":"invented-worker","identity":"host:invented:worker",
            "model":"invented/gpt-6-luna","presence":"live_busy",
            "execution":"active","source":"authenticated-host-baseline",
            "observedAt":now,"task":"st_active_worker",
            "parent":"invented-coordinator","created":created,
            "child":"invented-worker"
        }]
    });
    std::fs::write(&observation_path, observation.to_string()).unwrap();

    let tracker = ShimmedTracker::beside(&home);
    tracker.holds(&serde_json::json!([
        {
            "id":"ark-focus-root","title":"Invented focused integration",
            "status":"in_progress","priority":1,"issue_type":"epic"
        },
        {
            "id":"ark-focus-child","title":"Invented focused check",
            "status":"open","priority":2,"issue_type":"task","parent":"ark-focus-root",
            "dependencies":[{"depends_on_id":"ark-focus-root","type":"parent-child"}]
        },
        {
            "id":"ark-worker","title":"Invented delegated worker bead",
            "status":"in_progress","priority":2,"issue_type":"task",
            "metadata":{
                "qrclipWork":{"attempt":{
                    "id":"invented-attempt","coordinator":"invented-coordinator","mode":"delegate"
                }},
                "qrclipDispatch":{
                    "attemptId":"invented-attempt","taskId":"st_active_worker",
                    "toolCallId":"invented-call","outcome":"native-admitted"
                }
            }
        }
    ]).to_string());

    let json = terminal::bdi_on_pipes(&home)
        .args(["ark-focus-root", "--all", "--json"])
        .envs(tracker.environment())
        .output()
        .unwrap();
    assert!(
        json.status.success(),
        "focused --json invocation succeeds: {}",
        String::from_utf8_lossy(&json.stderr)
    );
    let snapshot: serde_json::Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(
        snapshot["off_focus_workers"],
        serde_json::json!([{
            "project":"arkham","id":"ark-worker",
            "role":"delegated_worker","execution":"active"
        }])
    );

    let refreshed_at = chrono::Utc::now();
    observation["observedAt"] = serde_json::json!(refreshed_at);
    observation["expiresAt"] = serde_json::json!(refreshed_at + chrono::Duration::seconds(5));
    observation["workers"][0]["observedAt"] = serde_json::json!(refreshed_at);
    std::fs::write(&observation_path, observation.to_string()).unwrap();

    let mut bdi = Driven::bdi_with_arguments(
        36,
        140,
        home,
        &["--all", "ark-focus-root"],
        &tracker.environment(),
    );
    bdi.read_until(ENTER_ALTERNATE_SCREEN, GIVING_UP);
    bdi.read_until(b"v Activity", GIVING_UP);
    let repaint = bdi.resize(37, 140);
    let screen = bdi.answer_to(repaint, GIVING_UP);
    let rows = terminal::rows_drawn(&screen);
    let text = rows.join("\n");
    assert!(
        text.contains("Invented focused integration"),
        "the requested integration tree stays focused: {text}"
    );
    assert!(
        !text.contains("Invented delegated worker bead"),
        "the off-focus worker stays outside the focused tree: {text}"
    );
    assert!(
        rows.iter()
            .any(|row| row.contains('1') && row.contains("Home") && row.contains("v Activity")),
        "the off-focus count notice truthfully offers Home and Activity navigation: {text}"
    );

    let home = bdi.send(b"\x1b[H");
    bdi.answer_to(home, GIVING_UP);
    let activity = bdi.send(b"v");
    bdi.answer_to(activity, GIVING_UP);
    let repaint = bdi.resize(38, 140);
    let screen = bdi.answer_to(repaint, GIVING_UP);
    let text = terminal::rows_drawn(&screen).join("\n");
    assert!(
        text.contains("Invented delegated worker bead"),
        "Activity navigation reveals the qualified active worker bead: {text}"
    );
    bdi.send(b"q");
}

#[test]
fn settled_delegate_is_identifiable_without_a_live_observer_frame() {
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::fs;

    let home = a_home_naming_one_project_settled(
        "settled-delegate-without-frame",
        "[row]\ncompact=true\nshow_ids=false\n",
    );
    let tasks = home.join("native-tasks");
    let observations = home.join("observations");
    fs::create_dir_all(&tasks).unwrap();
    fs::create_dir_all(&observations).unwrap();
    let cfg = home.join(".config/beady-eye/config.toml");
    let mut config = fs::read_to_string(&cfg).unwrap();
    config.push_str(&format!(
        "\n[omo.arkham]\ntask_directory='{}'\nobservation_directory='{}'\n",
        tasks.display(),
        observations.display()
    ));
    fs::write(cfg, config).unwrap();
    let created = "2026-01-01T00:00:00Z";
    let scope = json!({"project":"arkham","taskDirectory":tasks});
    let parent = "invented-preparer";
    let cache_key = serde_json::to_vec(&(&scope, parent)).unwrap();
    let cache_hash: String = Sha256::digest(cache_key)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    fs::write(
        observations.join(format!("admission-{cache_hash}.json")),
        json!({
            "version":1,"scope":scope,"parent":parent,
            "admissions":[{
                "bead":"ark-audit","attempt":"invented-attempt","toolCall":"invented-call",
                "task":"st_audit","parent":parent,"created":created,
                "initialChild":"invented-auditor","invalid":false,"runEpoch":3
            }]
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        tasks.join("st_audit.json"),
        json!({
            "task_id":"st_audit","created_at":created,"updated_at":chrono::Utc::now(),
            "status":"completed","parent_session_id":parent,
            "child_session_id":"invented-auditor","notification":{"run_epoch":3}
        })
        .to_string(),
    )
    .unwrap();
    let tracker = ShimmedTracker::beside(&home);
    tracker.holds(
        &json!([{
            "id":"ark-audit","title":"Invented finished audit","status":"in_progress",
            "priority":2,"issue_type":"task","metadata":{
                "qrclipWork":{"attempt":{"id":"invented-attempt","coordinator":parent,"mode":"delegate"}},
                "qrclipDispatch":{
                    "attemptId":"invented-attempt","taskId":"st_audit","toolCallId":"invented-call",
                    "outcome":"native-admitted"
                }
            }
        }])
        .to_string(),
    );
    let result = terminal::bdi_on_pipes(&home)
        .args(["--json", "--all", "ark-audit"])
        .envs(tracker.environment())
        .output()
        .unwrap();
    assert!(result.status.success(), "{:?}", result.stderr);
    let snapshot: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    let node = &snapshot["trees"][0]["nodes"][0];
    assert_eq!(node["id"], "ark-audit");
    assert_eq!(node["activity"]["child_session"], "invented-auditor");
    assert_eq!(node["execution"], "inactive");
    assert_eq!(node["agent_live"], false);
    assert_eq!(node["activity"]["acceptance_ready"], false);

    let mut bdi = Driven::bdi_with_arguments(40, 120, home, &["--all"], &tracker.environment());
    bdi.read_until(ENTER_ALTERNATE_SCREEN, GIVING_UP);
    bdi.read_until(b"audit", GIVING_UP);
    let selected = bdi.send(b"/ark-audit\r");
    bdi.answer_to(selected, GIVING_UP);
    let open = bdi.send(b"\r");
    bdi.answer_to(open, GIVING_UP);
    let repaint = bdi.resize(42, 120);
    let frame = bdi.answer_to(repaint, GIVING_UP);
    assert_eq!(terminal::window_over(&frame).as_deref(), Some("ark-audit"));
    let screen = terminal::rows_drawn(&frame).join("\n");
    assert!(screen.contains("invented-auditor"), "{screen}");
    assert!(screen.contains("Inactive"), "{screen}");
    bdi.send(b"\x1bq");
}

#[test]
fn childless_current_receipt_keeps_completed_native_record_unverified() {
    let home = a_home_naming_one_project_settled(
        "childless-native-receipt",
        "[row]\ncompact=true\nshow_ids=false\nascii=true\n",
    );
    let tasks = home.join("native-tasks");
    std::fs::create_dir_all(&tasks).unwrap();
    let config_path = home.join(".config/beady-eye/config.toml");
    let mut config = std::fs::read_to_string(&config_path).unwrap();
    config.push_str(&format!(
        "\n[omo.arkham]\ntask_directory='{}'\nacceptance_ready_path='metadata.reviewReady'\n",
        tasks.display()
    ));
    std::fs::write(config_path, config).unwrap();

    std::fs::write(
        tasks.join("st_reused.json"),
        serde_json::json!({
            "task_id":"st_reused","status":"completed","parent_session_id":"invented-coordinator",
            "child_session_id":"invented-old-child","name":"invented-old-worker","agent_type":"reviewer",
            "effective_model":{"provider":"invented","model_id":"invented-model"},
            "updated_at":chrono::Utc::now().to_rfc3339()
        })
        .to_string(),
    )
    .unwrap();

    let tracker = ShimmedTracker::beside(&home);
    tracker.holds(&serde_json::json!([{
        "id":"ark-reused","title":"Invented gateway check","status":"in_progress","priority":2,"issue_type":"task",
        "metadata":{
            "qrclipWork":{
                "attempt":{"id":"invented-current-attempt","coordinator":"invented-coordinator","mode":"delegate"},
                "checked":{"attemptId":"invented-current-attempt","passed":true,"checkedAt":"2026-11-14T09:05:00Z"}
            },
            "qrclipDispatch":{"attemptId":"invented-current-attempt","taskId":"st_reused","nativeStatus":"completed"},
            "reviewReady":{"attemptId":"invented-current-attempt","ready":true}
        }
    }]).to_string());

    let mut bdi = Driven::bdi(30, 100, home, &tracker.environment());
    bdi.read_until(ENTER_ALTERNATE_SCREEN, GIVING_UP);
    bdi.read_until(b"[~]", GIVING_UP);
    let seek = bdi.send(b"/ark-reused\r");
    bdi.answer_to(seek, GIVING_UP);
    let repaint = bdi.resize(31, 100);
    let screen = bdi.answer_to(repaint, GIVING_UP);
    let text = terminal::rows_drawn(&screen).join("\n");
    assert!(
        text.contains("[~]"),
        "unverified task stays uncertain: {text}"
    );
    assert!(
        !text.contains("[T]"),
        "unverified completion is not shown: {text}"
    );
    assert!(
        !text.contains("[A]"),
        "unverified record cannot show acceptance: {text}"
    );
    assert!(
        !text.contains("invented-model"),
        "unverified model stays hidden: {text}"
    );

    let detail = bdi.send(b"\r");
    bdi.answer_to(detail, GIVING_UP);
    let repaint = bdi.resize(32, 100);
    let screen = bdi.answer_to(repaint, GIVING_UP);
    let details = terminal::rows_drawn(&screen).join("\n");
    assert_eq!(
        terminal::window_over(&screen).as_deref(),
        Some("ark-reused")
    );
    assert!(
        details.contains("unverified") || details.contains("not attributed"),
        "details explain why the reusable task record is uncertain: {details}"
    );
    assert!(
        details.contains("completed") || details.contains("task status"),
        "details retain the unverified record as evidence: {details}"
    );
    bdi.send(b"\x1bq");
}

#[test]
fn compact_detail_relations_use_brackets_at_narrow_and_wide_widths() {
    for cols in [30, 60] {
        for coloured in [false, true] {
            let home = a_home_naming_one_project_settled(
                &format!("detail-markers-{cols}-{coloured}"),
                &format!("[row]\ncolour_brackets={coloured}\n"),
            );
            let tracker = ShimmedTracker::beside(&home);
            tracker.holds(&serde_json::json!([
                {"id":"ark-1","title":"Invented parent","status":"blocked"},
                {"id":"ark-1.1","title":"Invented child","status":"in_progress","description":"See ark-2 for context.","dependencies":[{"depends_on_id":"ark-1","type":"parent-child"}]},
                {"id":"ark-2","title":"Invented preparation","status":"hooked"}
            ]).to_string());
            let mut app = Driven::bdi(36, cols, home, &tracker.environment());
            app.read_until(ENTER_ALTERNATE_SCREEN, GIVING_UP);
            app.read_until(b"Invented", GIVING_UP);
            let seek = app.send(b"/ark-1.1\r ");
            app.answer_to(seek, GIVING_UP);
            let repaint = app.resize(37, cols);
            let screen = app.answer_to(repaint, GIVING_UP);
            let text = terminal::rows_drawn(&screen).join("\n");
            assert!(text.contains("[~] ark-1.1"), "{text}");
            assert!(text.contains("[?] ark-1"), "{text}");
            assert!(text.contains("[<] ark-2"), "{text}");
            assert!(terminal::window_over(&screen).is_some());
            app.send(b"\x1bq");
        }
    }
}

#[test]
fn live_native_owners_are_visible_on_beads_and_open_their_linked_details() {
    use terminal::shims::ShimmedHerdr;
    for cols in [30, 60] {
        let home = a_home_naming_one_project_settled(
            &format!("live-native-{cols}"),
            "[row]\nascii=true\nhide_root_indent='always'\n",
        );
        let config_path = home.join(".config/beady-eye/config.toml");
        let mut config = std::fs::read_to_string(&config_path).unwrap();
        let logs = home.join("native-sessions");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(
            logs.join("invented_owner-a.jsonl"),
            format!(
                "{}\n{}\n",
                serde_json::json!({"type":"session","version":3,"id":"owner-a"}),
                serde_json::json!({"type":"model_change","provider":"invented","modelId":"model-a"})
            ),
        )
        .unwrap();
        config.push_str(&format!(
            "\n[omo.arkham]\ntask_directory='{}'\nsession_directory='{}'\n",
            logs.join("tasks").display(),
            logs.display()
        ));
        std::fs::write(config_path, config).unwrap();
        let tracker = ShimmedTracker::beside(&home);
        tracker.holds(&serde_json::json!([
            {"id":"ark-1","title":"Gateway","status":"in_progress","metadata":{"qrclipWork":{"attempt":{"id":"attempt-a","coordinator":"owner-a","mode":"direct"}}}},
            {"id":"ark-2","title":"Search","status":"in_progress","metadata":{"qrclipWork":{"attempt":{"id":"attempt-b","coordinator":"owner-a","mode":"delegate"}}}}
        ]).to_string());
        let herdr = ShimmedHerdr::beside(&home);
        let project_path = home.join("arkham");
        // Use the project directory configured by the shared invented home.
        let configured: toml::Value = toml::from_str(
            &std::fs::read_to_string(home.join(".config/beady-eye/config.toml")).unwrap(),
        )
        .unwrap();
        let cwd = configured["projects"][0]["path"]
            .as_str()
            .unwrap_or(project_path.to_str().unwrap());
        herdr.holds_in("default",&serde_json::json!({"result":{"agents":[{"pane_id":"w:p1","cwd":cwd,"agent_status":"working","agent":"pi","title":"Invented coordinator","agent_session":{"agent":"pi","kind":"id","source":"invented","value":"owner-a"}}]}}).to_string());
        let mut env = tracker.environment();
        env.extend(herdr.environment());
        let mut app = Driven::bdi(28, cols, home, &env);
        app.read_until(ENTER_ALTERNATE_SCREEN, GIVING_UP);
        app.read_until(b"model-a", GIVING_UP);
        let seek = app.send(b"/ark-2\r");
        app.answer_to(seek, GIVING_UP);
        let repaint = app.resize(29, cols);
        let screen = app.answer_to(repaint, GIVING_UP);
        let text = terminal::rows_drawn(&screen).join("\n");
        assert!(text.contains("@ model-a"), "{cols}: {text}");
        if cols >= 60 {
            assert!(text.contains("coord live"), "{text}");
        }
        assert!(!text.contains("unclaimed pane"), "{text}");
        let detail = app.send(b"\r");
        app.answer_to(detail, GIVING_UP);
        let repaint = app.resize(30, cols);
        let screen = app.answer_to(repaint, GIVING_UP);
        assert_eq!(terminal::window_over(&screen).as_deref(), Some("ark-2"));
        app.send(b"\x1bq");
    }
}
