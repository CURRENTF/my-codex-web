import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location("probe", Path(__file__).parents[2] / "scripts/tunnel-transfer-probe.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        padded = len(self.headers.get("X-Tunnel-Probe", ""))
        if padded:
            self.server.padded.append(padded)
            time.sleep(self.server.delay)
        if self.path == "/":
            status, body = 200, b'<script src="/assets/index-test.js"></script>'
        elif self.path == "/api/auth/status":
            status, body = 200, b'{"passwordRequired":true,"authenticated":false}'
        elif self.path == "/assets/index-test.js":
            status = 206
            body = b"x" * (module.DOWNLOAD_BYTES - int(self.server.truncated))
        else:
            status, body = 404, b""
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


class Server(ThreadingHTTPServer):
    request_queue_size = 32


class ProbeTest(unittest.TestCase):
    def setUp(self):
        self.server = Server(("127.0.0.1", 0), Handler)
        self.server.delay = 0
        self.server.truncated = False
        self.server.padded = []
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()

    def test_transfers_both_directions_without_authentication(self):
        result = module.probe(self.origin)
        self.assertEqual(sum(self.server.padded), 128 * 1024)
        self.assertGreaterEqual(result["responseBytes"], 128 * 1024)

    def test_rejects_small_request_success_when_transfer_is_slow(self):
        self.server.delay = 0.3
        with self.assertRaises((TimeoutError, OSError)):
            module.probe(self.origin, timeout=0.1)

    def test_rejects_truncated_asset(self):
        self.server.truncated = True
        with self.assertRaises(ValueError):
            module.probe(self.origin)


if __name__ == "__main__":
    unittest.main()
