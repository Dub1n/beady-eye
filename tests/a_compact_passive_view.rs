//! A real terminal loop over invented Beads and OmO records at sidebar widths.
mod terminal;
use std::time::Duration;
use terminal::driver::{Driven, GIVING_UP};
use terminal::shims::ShimmedTracker;
use terminal::{a_home_naming_one_project_settled, ENTER_ALTERNATE_SCREEN};

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
