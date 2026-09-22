#!/usr/bin/env python3
"""Static file server for development.

Same as `python -m http.server`, except it tells the browser not to cache
anything. Without that the ES modules and the stylesheet are served with a
Last-Modified header, and an edit does not show up until a hard reload — which
is easy to mistake for the change not working.

    python serve.py [port]

Web Serial needs a secure context; 127.0.0.1 qualifies, a file:// URL does not.
"""

import http.server
import sys
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(Path(__file__).parent), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        # The default logs every asset on every reload; only report failures.
        if not args or not str(args[1]).startswith("2"):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"serving {Path(__file__).parent} at http://127.0.0.1:{PORT}/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
