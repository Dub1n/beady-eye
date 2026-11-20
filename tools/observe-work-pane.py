#!/usr/bin/env python3
"""Usage: python3 tools/observe-work-pane.py --bdi ABS --sha256 HEX --project NAME --bead FULL_ID --output-dir PRIVATE_PARENT [--config ABS] [--seconds N] [--interval N].

Run from a Herdr pane dedicated to this viewer. The recorder execs pinned bdi
in the current pane and leaves it running after the observation window.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from observe_work_pane import Capture, Options, RecorderError, launch


def main() -> int:
    if sys.argv[1:2] == ["--observer-helper"]:
        if len(sys.argv) != 3:
            return 2
        try:
            return Capture(Path(sys.argv[2])).run()
        except (RecorderError, OSError, ValueError) as error:
            print(f"observe-work-pane helper: {error}", file=sys.stderr)
            return 2
    parser = argparse.ArgumentParser(
        description="Exec pinned bdi in this Herdr pane with bounded private observation."
    )
    parser.add_argument("--bdi", required=True, type=Path, help="absolute pinned bdi executable")
    parser.add_argument("--sha256", required=True, help="expected lowercase bdi SHA-256")
    parser.add_argument("--project", required=True, help="exact configured project name")
    parser.add_argument("--bead", required=True, help="exact full bead ID")
    parser.add_argument("--output-dir", required=True, type=Path, help="existing private parent directory")
    parser.add_argument("--config", type=Path, help="absolute bdi configuration file")
    parser.add_argument("--seconds", type=int, default=120, help="capture window, from 1 to 120 seconds")
    parser.add_argument("--interval", type=int, default=5, help="sample interval, from 1 to 30 seconds")
    args = parser.parse_args()

    try:
        launch(Options(
            bdi=args.bdi,
            sha256=args.sha256,
            project=args.project,
            bead=args.bead,
            output_dir=args.output_dir,
            config=args.config,
            seconds=args.seconds,
            interval=args.interval,
        ))
    except RecorderError as error:
        parser.exit(2, f"observe-work-pane: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
