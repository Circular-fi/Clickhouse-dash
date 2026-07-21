#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def fetch(url: str, etag: str | None = None) -> tuple[dict | None, str | None]:
    request = urllib.request.Request(url)
    if etag:
        request.add_header("If-None-Match", etag)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return payload, response.headers.get("ETag")
    except urllib.error.HTTPError as exc:
        if exc.code == 304:
            return None, etag
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8080/api/state")
    parser.add_argument("--job", choices=["tests", "benchmark", "all"], default="tests")
    parser.add_argument("--timeout", type=float, default=900)
    parser.add_argument("--poll", type=float, default=2)
    args = parser.parse_args()

    deadline = time.monotonic() + args.timeout
    saw_job = False
    last = None
    state: dict = {}
    etag: str | None = None
    while time.monotonic() < deadline:
        updated, etag = fetch(args.url, etag)
        if updated is not None:
            state = updated
        active = state.get("active")
        if isinstance(active, dict) and (active.get("kind") == args.job or args.job == "all"):
            saw_job = True
            last = active
            print(f"running {active.get('kind')} {active.get('id')} phase={active.get('phase')}", flush=True)
            time.sleep(args.poll)
            continue
        history = state.get("history") if isinstance(state.get("history"), list) else []
        for job in history:
            if isinstance(job, dict) and job.get("kind") == args.job:
                print(json.dumps(job, ensure_ascii=False, indent=2), flush=True)
                return 0 if job.get("status") == "passed" and int(job.get("returncode") or 0) == 0 else 1
        if saw_job and last:
            print("job disappeared without history entry", file=sys.stderr)
            return 1
        time.sleep(args.poll)
    print(f"timeout waiting for {args.job}", file=sys.stderr)
    return 124


if __name__ == "__main__":
    raise SystemExit(main())
