#!/usr/bin/env python3
"""Read-only loopback probe for an HTTP reverse tunnel; run under timeout(1)."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import re
import time
from urllib.request import build_opener, ProxyHandler, Request

PAD_BYTES = 8192
REQUESTS = 16
DOWNLOAD_BYTES = 128 * 1024


def probe(origin, timeout=6):
    started = time.monotonic()

    def read(target, limit, headers=None):
        # Avoid routing a local tunnel check through ambient HTTP proxy settings.
        opener = build_opener(ProxyHandler({}))
        request = Request(origin + target, headers=headers or {})
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read(limit)

    status, html = read("/", 64 * 1024)
    asset = re.search(rb'src="(/assets/[^"<>\s]+\.js)"', html)
    if status != 200 or not asset:
        raise ValueError("cannot discover the application JavaScript asset")

    def transfer(index):
        # Many bounded headers exercise M -> target without sending a user
        # message, uploading a file, or requiring any authentication secret.
        headers = {"X-Tunnel-Probe": "x" * PAD_BYTES}
        if index == 0:
            headers["Range"] = f"bytes=0-{DOWNLOAD_BYTES - 1}"
            status, body = read(asset[1].decode("ascii"), DOWNLOAD_BYTES + 1, headers)
            if status != 206 or len(body) != DOWNLOAD_BYTES:
                raise ValueError("incomplete ranged asset response")
        else:
            status, body = read("/api/auth/status", 4096, headers)
            if status != 200 or not isinstance(json.loads(body).get("passwordRequired"), bool):
                raise ValueError("unexpected authentication status response")
        return len(body)

    with ThreadPoolExecutor(max_workers=REQUESTS) as pool:
        received = sum(pool.map(transfer, range(REQUESTS)))
    elapsed = time.monotonic() - started
    if elapsed > timeout:
        raise TimeoutError("transfer deadline exceeded")
    return {"seconds": round(elapsed, 3), "requestHeaderBytes": PAD_BYTES * REQUESTS,
            "responseBytes": received}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=12100)
    parser.add_argument("--timeout", type=float, default=6)
    args = parser.parse_args()
    try:
        print(json.dumps(probe(f"http://127.0.0.1:{args.port}", args.timeout)))
    except Exception as error:
        # Do not log response bodies, URLs from responses, or request headers.
        print(json.dumps({"error": type(error).__name__}), flush=True)
        raise SystemExit(1)
