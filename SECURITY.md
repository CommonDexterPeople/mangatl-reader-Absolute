# Security

MangaTL-Reader is a single-user tool that runs on your own machine. This file
describes what that does and doesn't protect, so you can decide how to run it.

## Threat model in one paragraph

The server binds to `127.0.0.1` and has **no authentication of its own**. The
security model is "only you can reach it", not "it checks who you are". Your
API keys live in your browser's `localStorage` in plaintext and are sent to
the local server with each request that needs one — the server never stores
them, never logs them, and writes nothing to disk.

## What is actually defended

| Risk | Defence | Where |
|---|---|---|
| SSRF — tricking the server into fetching arbitrary URLs | Image fetches are restricted to an allowlist of MangaDex CDN hosts (plus one exact opt-in Suwayomi `host:port`), not "any `https://`" | [`mtl/security.py`](mtl/security.py) |
| CSRF — a site you have open POSTing to your local server | Cross-origin `Origin` headers are rejected | `_block_cross_origin()` in [`server.py`](server.py) |
| DNS rebinding — a hostile domain re-resolving to `127.0.0.1` to read responses | Unexpected `Host` headers are rejected | `_block_cross_origin()` in [`server.py`](server.py) |
| Accidental network exposure | Refuses to start on a non-localhost address unless `MTL_ALLOW_EXPOSED=1` is set deliberately | `_check_exposure_or_exit()` in [`mtl/security.py`](mtl/security.py) |
| Oversized request bodies | 40 MB request cap, 25 MB per decoded page image | [`server.py`](server.py), [`mtl/security.py`](mtl/security.py) |
| XSS from API-sourced text | Externally-sourced strings are HTML-escaped before rendering; [`audit_innerhtml.py`](audit_innerhtml.py) reports every unescaped interpolation for review | `static/js/` |

## What is NOT defended

- **There is no authentication.** Anyone who can reach the port can use every
  route. That is fine on `127.0.0.1` and not fine anywhere else.
- **Exposing it to a network is your responsibility.** If you set a
  non-localhost `HOST` and `MTL_ALLOW_EXPOSED=1`, put real auth in front of it
  (reverse proxy, VPN). Use `MTL_ALLOWED_HOSTS` to name the hostnames your
  proxy forwards.
- **API keys are stored in plaintext in `localStorage`.** Anything with access
  to your browser profile can read them. Treat them as you would any key
  pasted into a local dev tool, and revoke them if you share the machine.
- **Your AI provider sees your page images and OCR'd text.** That is inherent
  to using a translation API, not something this tool can mitigate.

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/CommonDexterPeople/mangatl-reader-Absolute/issues).
If you'd rather not disclose it publicly, open an issue saying only that you
have a security report and I'll follow up privately.

This is a personal project maintained in spare time — there is no SLA. Please
say plainly what an attacker can actually do, and include the request that
demonstrates it if there is one.
