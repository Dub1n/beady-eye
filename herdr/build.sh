#!/bin/sh
# Build this checkout rather than fetching an upstream binary with the same tag.
# Local links and GitHub installations use the same canonical source build.
set -eu
root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
if ! command -v cargo >/dev/null 2>&1; then
  echo 'beady-eye: this fork requires Rust 1.88+ (cargo) for installation.' >&2
  exit 1
fi
cargo build --locked --release --manifest-path "$root/Cargo.toml" --target-dir "$root/target" --bin bdi
mkdir -p "$root/bin"
install -m 0755 "$root/target/release/bdi" "$root/bin/bdi"
