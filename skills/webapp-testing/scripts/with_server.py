#!/usr/bin/env python3
"""Start owned local test servers, run a test command, then stop their process groups.

Adapted from Anthropic's Apache-2.0 webapp-testing helper for localDot, 2026-10-18.
See ../LICENSE.txt and ../UPSTREAM.md. Refuses occupied ports, drains logs without pipe
backpressure and cleans up descendants even when a test fails.
"""
import argparse
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time


def listening(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", action="append", required=True)
    parser.add_argument("--port", action="append", type=int, required=True)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or len(args.server) != len(args.port):
        parser.error("Supply a command and one --port for each --server")
    if len(set(args.port)) != len(args.port) or any(not 1 <= p <= 65535 for p in args.port):
        parser.error("Ports must be distinct and between 1 and 65535")
    if not 0 < args.timeout <= 300:
        parser.error("Timeout must be between 0 and 300 seconds")
    if any(listening(port) for port in args.port):
        parser.error("A requested port is already in use. Reuse that server or select another port.")
    owned = []
    try:
        for command_text, port in zip(args.server, args.port):
            log = tempfile.TemporaryFile()
            process = subprocess.Popen(command_text, shell=True, start_new_session=True,
                                       stdout=log, stderr=log)
            owned.append((process, log))
            deadline = time.monotonic() + args.timeout
            while not listening(port):
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError(f"Test server on port {port} did not become ready")
                time.sleep(0.1)
            if process.poll() is not None:
                raise RuntimeError(f"Test server on port {port} exited during startup")
        return subprocess.run(command, check=False).returncode
    finally:
        for process, log in reversed(owned):
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=3)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                pass
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                log.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, KeyboardInterrupt) as error:
        print(str(error) or "Interrupted", file=sys.stderr)
        sys.exit(1)
