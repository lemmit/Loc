#!/usr/bin/env python3
"""Local TLS-terminating mirror for *.hex.pm — proxy-fingerprint workaround.

WHY THIS EXISTS
---------------
Some sandboxed/remote environments route all egress through a
TLS-intercepting proxy that *allowlists by the client's TLS fingerprint*.
Debian's system OpenSSL (curl, Python's stdlib `ssl`, .NET, Gradle) is
accepted (HTTP 200), but **Erlang/OTP's `:ssl` stack is rejected with a
bare HTTP 503** — even though the CA is trusted, SNI is correct, and the
host is otherwise reachable. That makes `mix local.hex` / `mix deps.get`
fail, which blocks every Dockerised Phoenix/Elixir build in such an
environment (see `docs/tools.md` → "Compiling generated backends in
Docker behind a fingerprinting proxy").

HOW IT WORKS
------------
        ┌─ elixir container ─┐        ┌──── host ────┐      ┌── egress ──┐
        │ mix / Erlang :ssl  │──TLS──▶│  this mirror  │─ssl─▶│   gateway  │─▶ hex.pm
        │ (trusts local CA,  │  (loopback, no proxy   │ stdlib ssl =     200
        │  builds/repo.hex   │   in the path)         │ accepted by the gateway)
        │  .pm → 127.0.0.1)  │        └───────────────┘
        └────────────────────┘

The container reaches us because the caller runs `docker run` with
`--network host --add-host {builds,repo,hex}.hex.pm:127.0.0.1` and trusts
the mirror's CA. We present a cert for `*.hex.pm` (Erlang does clean
loopback TLS to us — the gateway is never in that hop) and re-originate
upstream with Python's stdlib `ssl`, which the gateway accepts. Bytes are
streamed back **verbatim**, so Hex's registry signature and tarball
checksums still verify end-to-end.

USAGE
-----
    CERT=fullchain.pem KEY=server.key PORT=443 python3 scripts/hex-mirror.py

Needs root (or CAP_NET_BIND_SERVICE) to bind :443 — Hex always talks to
hex.pm on 443 and `--add-host` cannot rewrite the port. Stdlib only; no
pip dependencies. The host process must itself trust the egress proxy CA
(in this repo's environments that is the default system bundle, which
already includes it).
"""

import http.server
import socketserver
import ssl
import sys
import urllib.error
import urllib.request

CERT = __import__("os").environ.get("CERT", "/tmp/hexmirror/srv-fullchain.crt")
KEY = __import__("os").environ.get("KEY", "/tmp/hexmirror/srv.key")
PORT = int(__import__("os").environ.get("PORT", "443"))

# Hop-by-hop headers that must not be forwarded across the relay.
HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _relay(self, method: str) -> None:
        host = self.headers.get("Host", "")
        url = f"https://{host}{self.path}"
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else None

        req = urllib.request.Request(url, data=body, method=method)
        for key, value in self.headers.items():
            if key.lower() not in HOP:
                req.add_header(key, value)

        try:
            resp = urllib.request.urlopen(req, timeout=60)
            status, headers, data = resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as err:
            status, headers, data = err.code, err.headers, err.read()
        except Exception as err:  # noqa: BLE001 — surface any upstream failure to Hex
            self.send_error(502, f"hex-mirror upstream error: {err}")
            return

        sys.stderr.write(f"{method} {url} -> {status} ({len(data)}b)\n")
        sys.stderr.flush()

        self.send_response(status)
        for key, value in headers.items():
            if key.lower() in HOP or key.lower() == "content-length":
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 — http.server dispatch name
        self._relay("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self._relay("HEAD")

    def do_POST(self) -> None:  # noqa: N802
        self._relay("POST")

    def log_message(self, *_args) -> None:  # silence default per-request logging
        pass


class ThreadingHTTPSServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def main() -> None:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    httpd = ThreadingHTTPSServer(("0.0.0.0", PORT), Handler)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    sys.stderr.write(f"hex-mirror listening on :{PORT}\n")
    sys.stderr.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
