#!/usr/bin/python3
"""Route Herdr CLI calls exclusively to this test's private Unix socket."""

import json
import os
import socket
import sys


def main():
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(20)
        client.connect(os.environ["RECORDER_FIXTURE_SOCKET"])
        client.sendall(json.dumps(sys.argv[1:]).encode() + b"\n")
        with client.makefile("rb") as stream:
            reply = json.loads(stream.readline())
    sys.stdout.write(reply["stdout"])
    sys.stderr.write(reply["stderr"])
    return reply["status"]


if __name__ == "__main__":
    raise SystemExit(main())
