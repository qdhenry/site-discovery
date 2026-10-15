# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include the steps to reproduce, the affected version or commit, and the impact you expect. You should get an acknowledgement within 7 days.

## Supported versions

Security fixes go to the latest release on `main`.

## Deployment model and scope

Site Discovery is a **local, single-owner tool**. Its security assumptions:

- The service binds to `127.0.0.1` only. Exposing it on a network, or putting it behind a public proxy, is unsupported.
- Access requires the local owner token in `.local/discovery/owner-token` (or `DISCOVERY_OWNER_TOKEN`). Anyone who can read that file, or your `.env`, can use your Cloudflare and Anthropic credentials and spend against your limits.
- The development mini-host origin `http://localhost:5193` is allowed credentialed CORS. Any page served on that port can act with an owner session signed in on `localhost`. Don't run untrusted servers on port 5193 while you're signed in.
- Captured pages are untrusted. Screenshots and DOM go to Claude as evidence only, and model output must pass strict schemas. Prompt injection that escapes this boundary, for example by triggering saves, tool use or network calls, is in scope.

In scope: authentication or origin bypass, path traversal in the private asset routes, SSRF past URL validation (private or loopback targets, DNS rebinding, redirects), credential exposure to the browser or logs, and budget-accounting bypass.

Out of scope: attacks that require local filesystem access to the state directory, and misconfigured Cloudflare or Anthropic accounts.
