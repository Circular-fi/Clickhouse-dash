#!/usr/bin/env python3
"""A short concurrent load on a sanitized server (tests/tools/sanitize.sh load).

The test suites send one request at a time. The races are elsewhere: two requests that share a cache, the
client pool, the query registry or a query session at the same time; a stream that the browser drops while
the encoder thread writes; a cancel that arrives while the query starts. This script drives that traffic from
several threads for a fixed time. It judges nothing but the life of the server: the sanitizer judges the rest
(its report is in the server log, tests/tools/sanitize.sh reads it).

    python3 tests/sanitize/load.py --base-url http://chdash-tsan-server:8080 --seconds 90 --workers 12

Exit status: 0 when the server answered to the end, 1 when it stopped answering. Standard library only.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter

HOST = "local"
QUERIES = [
    "SELECT number, toString(number) AS s FROM numbers(200000)",
    "SELECT sleepEachRow(0.01), number FROM numbers(300) SETTINGS max_block_size = 1",
    "SELECT 1",
    "SELECT name, engine FROM system.tables LIMIT 50",
    "SELECT cityHash64(number) % 97 AS k, count() FROM numbers(1000000) GROUP BY k ORDER BY k",
    "SELECT * FROM system.numbers LIMIT 5000",
    "SELECT throwIf(number = 50, 'load test error') FROM numbers(100)",
]
FORMAT_SQL = [
    "select a,b,c from t where x=1 and y in (1,2,3) order by a",
    "SELECT count() FROM system.parts WHERE active GROUP BY database -- comment\n",
    "insert into t values (1, 'a'), (2, 'b')",
    "WITH x AS (SELECT 1) SELECT * FROM x UNION ALL SELECT 2",
]
GETS = [
    "/api/health",
    "/api/hosts",
    "/api/version",
    "/api/meta?host_id=" + HOST,
    "/api/explorer/catalog?host_id=" + HOST,
    "/api/explorer/catalog?host_id=" + HOST + "&refresh=1",
    "/api/explorer/functions?host_id=" + HOST,
    "/api/system/overview?host_id=" + HOST,
    "/api/system/activity?host_id=" + HOST,
    "/api/system/disks?host_id=" + HOST,
    "/api/traces/meta?host_id=" + HOST,
    "/api/traces/search?host_id=" + HOST + "&lookback_minutes=60",
    "/api/logs/meta?host_id=" + HOST,
    "/api/logs/search?host_id=" + HOST + "&lookback_minutes=60",
]


class Load:
    def __init__(self, base_url: str, deadline: float):
        self.base = base_url.rstrip("/")
        self.deadline = deadline
        self.counts: Counter[str] = Counter()
        self.lock = threading.Lock()
        self.refused = 0

    def count(self, key: str) -> None:
        with self.lock:
            self.counts[key] += 1

    def request(self, method: str, path: str, body: dict | None = None, timeout: float = 30.0):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as error:
            return error
        except (ConnectionRefusedError, ConnectionResetError) as error:
            with self.lock:
                self.refused += 1
            raise error

    def call(self, method: str, path: str, body: dict | None = None) -> tuple[int, bytes]:
        with self.request(method, path, body) as response:
            payload = response.read()
            self.count(f"{method} {path.split('?')[0]} {response.status}")
            return response.status, payload

    # One query: run it, then read its stream to the end, drop it half way, or cancel it.
    def query(self, rng: random.Random) -> None:
        status, payload = self.call("POST", "/api/query/run", {"host_id": HOST, "sql": rng.choice(QUERIES)})
        if status != 200:
            return
        run = json.loads(payload)
        mode = rng.choice(["read", "drop", "cancel", "cancel-first"])
        if mode == "cancel-first":
            self.call("POST", "/api/query/cancel", {"cancel_token": run["cancel_token"]})
        stream = self.request("GET", "/" + run["stream_url"].lstrip("/"), timeout=60)
        with stream:
            read = 0
            limit = rng.randint(1, 64) * 1024 if mode == "drop" else None
            while True:
                chunk = stream.read(8192)
                if not chunk:
                    break
                read += len(chunk)
                if limit is not None and read >= limit:
                    break
                if mode == "cancel" and read > 4096:
                    self.call("POST", "/api/query/cancel", {"cancel_token": run["cancel_token"]})
                    mode = "read"
        self.count(f"stream {mode}")

    def export(self, rng: random.Random) -> None:
        status, payload = self.call("POST", "/api/export/run", {"host_id": HOST, "format": rng.choice(["json", "csv"]),
                                                               "queries": [rng.choice(QUERIES[:4])]})
        if status != 200:
            return
        url = json.loads(payload)["download_url"]
        with self.request("GET", "/" + url.lstrip("/"), timeout=60) as download:
            if rng.random() < 0.5:
                download.read()
            else:
                download.read(1024)
        self.count("export download")

    def worker(self, seed: int) -> None:
        rng = random.Random(seed)
        actions = [self.query] * 4 + [self.export] + [self.get] * 4 + [self.metrics] + [self.format] * 2
        while time.monotonic() < self.deadline:
            action = rng.choice(actions)
            try:
                action(rng)
            except (ConnectionRefusedError, ConnectionResetError):
                time.sleep(0.5)
            except (OSError, ValueError, KeyError) as error:
                self.count(f"error {type(error).__name__}")

    def get(self, rng: random.Random) -> None:
        self.call("GET", rng.choice(GETS))

    def metrics(self, rng: random.Random) -> None:
        end = int(time.time() * 1000)
        refresh = "&refresh=1" if rng.random() < 0.2 else ""
        self.call("GET", f"/api/metrics/catalog?host_id={HOST}&start_ms={end - 3600_000}&end_ms={end}{refresh}")

    def format(self, rng: random.Random) -> None:
        sql = rng.choice(FORMAT_SQL)
        if rng.random() < 0.5:
            sql += f" /* {rng.randint(0, 9)} */"
        self.call("POST", "/api/format", {"host_id": HOST, "sql": sql})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--seconds", type=float, default=90)
    parser.add_argument("--workers", type=int, default=12)
    args = parser.parse_args()

    load = Load(args.base_url, time.monotonic() + args.seconds)
    threads = [threading.Thread(target=load.worker, args=(seed,), daemon=True) for seed in range(args.workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(args.seconds + 120)

    for key, value in sorted(load.counts.items()):
        print(f"{value:7d}  {key}")
    try:
        with load.request("GET", "/api/version", timeout=30) as response:
            alive = response.status == 200
    except OSError:
        alive = False
    if not alive:
        print("FAIL: the server does not answer after the load", file=sys.stderr)
        return 1
    print(f"load done: {sum(load.counts.values())} requests, {load.refused} refused connections")
    return 0


if __name__ == "__main__":
    sys.exit(main())
