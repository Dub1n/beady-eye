//! A single ownership forest projected from the complete dependency snapshot.
//! Relations remain on the nodes for details; no tracker data is rewritten.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use super::{Counts, Node, Snapshot, TrackerState, Tree};
use crate::model::join::BeadKey;
use crate::model::tree::{numeric_id_order, Link};
use crate::model::types::Edge;

pub(super) fn project(source: &Snapshot) -> Snapshot {
    let mut nodes: BTreeMap<BeadKey, Node> = BTreeMap::new();
    let mut parents = BTreeMap::new();
    for tree in source.collected.iter().chain(&source.trees) {
        for node in &tree.beads {
            nodes.entry(node.key()).or_insert_with(|| node.clone());
            if let Some(parent) = &node.parent {
                parents.insert(
                    node.key(),
                    BeadKey {
                        project: parent
                            .project
                            .clone()
                            .unwrap_or_else(|| node.project.clone()),
                        id: parent.id.clone(),
                    },
                );
            }
        }
    }
    // Explicit parent metadata wins. Structural parent edges also support
    // snapshots built without a raw row (including disconnected components).
    for tree in source.collected.iter().chain(&source.trees) {
        for (at, links) in tree.children.iter().enumerate() {
            for link in links.iter().filter(|link| link.edge == Edge::ParentChild) {
                if let (Some(parent), Some(child)) = (tree.beads.get(at), tree.beads.get(link.bead))
                {
                    parents.entry(child.key()).or_insert_with(|| parent.key());
                }
            }
        }
    }
    parents.retain(|_, parent| nodes.contains_key(parent));
    // A malformed ownership cycle must remain inspectable. Break one stable
    // edge per cycle rather than dropping its component or following it forever.
    let mut cycles = BTreeSet::new();
    let mut settled = BTreeSet::new();
    for key in nodes.keys() {
        let mut path: Vec<BeadKey> = Vec::new();
        let mut at = key.clone();
        while let Some(parent) = parents.get(&at).cloned() {
            if settled.contains(&at) {
                break;
            }
            if let Some(start) = path.iter().position(|seen| seen == &at) {
                cycles.extend(path[start..].iter().cloned());
                let root = path[start..].iter().min().unwrap().clone();
                parents.remove(&root);
                break;
            }
            path.push(at);
            at = parent;
        }
        settled.extend(path);
    }
    let order = |a: &BeadKey, b: &BeadKey| {
        nodes[a]
            .status
            .rank()
            .cmp(&nodes[b].status.rank())
            .then(nodes[a].priority.cmp(&nodes[b].priority))
            .then(a.project.cmp(&b.project))
            .then_with(|| numeric_id_order(&a.id, &b.id))
    };
    let mut children: BTreeMap<BeadKey, Vec<BeadKey>> = BTreeMap::new();
    for (child, parent) in &parents {
        children
            .entry(parent.clone())
            .or_default()
            .push(child.clone());
    }
    for siblings in children.values_mut() {
        siblings.sort_by(&order);
    }
    let mut roots: Vec<_> = nodes
        .keys()
        .filter(|key| !parents.contains_key(*key))
        .cloned()
        .collect();
    roots.sort_by(|a, b| {
        source
            .projects
            .iter()
            .position(|p| p == &a.project)
            .cmp(&source.projects.iter().position(|p| p == &b.project))
            .then_with(|| order(a, b))
    });
    let mut trees: Vec<Arc<Tree>> = Vec::new();
    for root in roots {
        let mut keys = Vec::new();
        let mut pending = vec![root.clone()];
        while let Some(key) = pending.pop() {
            pending.extend(children.get(&key).into_iter().flatten().rev().cloned());
            keys.push(key);
        }
        let indices: BTreeMap<_, _> = keys
            .iter()
            .enumerate()
            .map(|(i, key)| (key.clone(), i))
            .collect();
        let beads: Vec<_> = keys.iter().map(|key| nodes[key].clone()).collect();
        let links = keys
            .iter()
            .map(|key| {
                children
                    .get(key)
                    .into_iter()
                    .flatten()
                    .map(|child| Link {
                        bead: indices[child],
                        edge: Edge::ParentChild,
                        first: true,
                    })
                    .collect()
            })
            .collect();
        trees.push(Arc::new(Tree {
            project: root.project.clone(),
            root: root.id.clone(),
            title: nodes[&root].title.clone(),
            counts: Counts::over(&beads),
            tracker: TrackerState::Ok,
            orphaned_dependencies: beads
                .iter()
                .filter(|node| !node.orphaned_dependencies.is_empty())
                .map(|node| node.id.clone())
                .collect(),
            cycles: keys
                .iter()
                .filter(|key| cycles.contains(*key))
                .map(|key| key.id.clone())
                .collect(),
            beads,
            children: links,
        }));
    }
    for tree in source.collected.iter().chain(&source.trees) {
        if tree.tracker != TrackerState::Ok
            && !trees.iter().any(|held| {
                held.project == tree.project
                    && held.root == tree.root
                    && held.tracker == tree.tracker
            })
        {
            trees.push(Arc::clone(tree));
        }
    }
    let mut snapshot = source.clone();
    for tree in &trees {
        if !snapshot.projects.contains(&tree.project) {
            snapshot.projects.push(tree.project.clone());
        }
    }
    snapshot.collected = trees;
    snapshot.refilter(source.filter);
    snapshot
}
