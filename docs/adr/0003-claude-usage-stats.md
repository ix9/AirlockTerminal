# ADR 0003: Claude usage stats from claude.ai's own endpoint

**Status:** Accepted
**Date:** 2026-11-05

## Context
The title bar shows the user's Claude plan usage (current session and weekly limits, with
reset times). There is no public, documented API for consumer plan usage.

## Decision
The main process reads the same JSON endpoint that claude.ai's own Settings → Usage page uses,
with the user's existing logged-in session (`persist:chat` partition). Nothing extra is stored
and no credentials are handled by the app.

- **Read-only** GETs only, polled every 5 minutes and when the window gains focus.
- Parsing is defensive. If the request fails or the shape changes, the usage display hides
  itself and nothing else is affected.

## Consequences
- **Unofficial:** it may break without notice when claude.ai changes. That's accepted
  because the failure mode is "the stats disappear".
- Requires being logged in to claude.ai in the chat pane.
- Revisit if an official usage API becomes available.
