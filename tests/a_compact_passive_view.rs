//! A real terminal loop over invented Beads and OmO records at sidebar widths.
mod terminal;
use std::time::Duration;
use terminal::driver::{Driven, GIVING_UP};
use terminal::shims::ShimmedTracker;
use terminal::{a_home_naming_one_project_settled, ENTER_ALTERNATE_SCREEN};

#[test]
fn compact_native_completion_is_visible_and_details_work_at_sidebar_widths() {
    for cols in [30, 40, 60, 80] {
        let home = a_home_naming_one_project_settled(
            &format!("compact-{cols}"),
            "[row]\ncompact=true\nshow_ids=false\nindent=2\nascii=true\n",
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
                "qrclipDispatch":{"attemptId":"invented-attempt","taskId":"st_invented","nativeStatus":"running"}}
        }]).to_string());
        let mut bdi = Driven::bdi(24, cols, home, &tracker.environment());
        bdi.read_until(ENTER_ALTERNATE_SCREEN, GIVING_UP);
        bdi.read_until(b"[T]", GIVING_UP);
        bdi.settle(Duration::from_millis(80), GIVING_UP);
        let repaint = bdi.resize(25, cols);
        let screen = bdi.answer_to(repaint, GIVING_UP);
        let text = String::from_utf8_lossy(&screen);
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
        assert!(
            drawn
                .get(22)
                .is_some_and(|row| row.starts_with("[T]: finished")),
            "selected status stays above shortcuts at width {cols}: {text}"
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
