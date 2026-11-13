//! Conservative opt-in filtering of disposable records. All configured fields
//! must match; a title containing a word is never sufficient provenance.
use crate::model::types::Bead;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FixtureFilter {
    pub title: String,
    pub created_by: String,
    #[serde(default)]
    pub close_reason: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

impl FixtureFilter {
    pub fn valid(&self) -> bool {
        !self.title.is_empty()
            && !self.created_by.is_empty()
            && (self.close_reason.as_ref().is_some_and(|v| !v.is_empty())
                || self.description.as_ref().is_some_and(|v| !v.is_empty()))
            && self.close_reason.as_ref().is_none_or(|v| !v.is_empty())
            && self.description.as_ref().is_none_or(|v| !v.is_empty())
    }
    pub fn matches(&self, bead: &Bead) -> bool {
        self.valid()
            && bead.status.is_closed()
            && bead.title == self.title
            && bead.created_by.as_deref() == Some(self.created_by.as_str())
            && self
                .close_reason
                .as_ref()
                .is_none_or(|reason| bead.row.text("close_reason").as_ref() == Some(reason))
            && self.description.as_ref().is_none_or(|description| {
                bead.row.text("description").as_ref() == Some(description)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collect::bd::parse_beads;
    #[test]
    fn only_closed_records_with_all_three_exact_fields_match() {
        let filter = FixtureFilter {
            title: "Invented scratch check".into(),
            created_by: "invented-test-runner".into(),
            close_reason: Some("Invented cleanup".into()),
            description: None,
        };
        let source = serde_json::json!({"id":"ark-scratch", "title":filter.title,
            "created_by":filter.created_by,"close_reason":filter.close_reason,
            "status":"closed","priority":2,"issue_type":"task"});
        let parse = |v| {
            parse_beads(&serde_json::to_string(&vec![v]).unwrap())
                .unwrap()
                .remove(0)
        };
        assert!(filter.matches(&parse(source.clone())));
        for (key, value) in [
            ("status", "in_progress"),
            ("created_by", "architect"),
            ("title", "Invented scratch check for the actual product"),
            ("close_reason", "Accepted"),
        ] {
            let mut changed = source.clone();
            changed[key] = value.into();
            assert!(!filter.matches(&parse(changed)), "{key}");
        }
    }
    #[test]
    fn description_provenance_covers_accepted_and_cleanup_records() {
        let filter = FixtureFilter {
            title: "Invented disposable probe".into(),
            created_by: "invented-runner".into(),
            close_reason: None,
            description: Some("Invented contract-only input".into()),
        };
        for reason in ["Invented cleanup", "Accepted synthetic check"] {
            let source = serde_json::json!([{"id":"ark-probe", "title":filter.title,
                "created_by":filter.created_by,"description":filter.description,
                "close_reason":reason,"status":"closed","priority":2,"issue_type":"task"}]);
            let bead = parse_beads(&source.to_string()).unwrap().remove(0);
            assert!(filter.matches(&bead));
        }
        let mut broad = filter.clone();
        broad.description = None;
        assert!(
            !broad.valid(),
            "title and creator alone are not sufficient provenance"
        );
    }
}
