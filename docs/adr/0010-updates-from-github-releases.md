# ADR 0010: Updates from GitHub Releases

**Status:** Accepted: Phase 1 is built. Phases 2 and 3 are proposed.
**Date:** 2026-11-17

## Context
Installers are published on GitHub Releases (`ix9/AirlockTerminal`, a public repo). A `v*` tag
builds all three OSes and attaches them to a **draft** release, which is published by hand.
Updating today means noticing a release, downloading the installer and running it.

What's already in place:
- electron-builder already uploads `latest.yml`, `latest-mac.yml`, `latest-linux.yml` and
  `.blockmap` files with every release. These are the feeds `electron-updater` reads.
- Drafts are invisible to updaters, so publishing the draft stays the moment a release goes out.

What limits the options:
- **macOS builds are ad-hoc signed** (`identity: "-"`). Squirrel.Mac, which `electron-updater` uses
  on macOS, only installs an update signed by the same Developer ID as the running app. So **no
  silent install on macOS** until the app is signed and notarized (TODO: *Signed installers*).
  It also needs a `zip` target next to the `dmg`.
- **Windows NSIS** builds update fine unsigned. Without a `publisherName`, `electron-updater` skips
  the signature check. The download is still checked against the sha512 in `latest.yml`.
- **Linux AppImage** updates in place when the app is run from the AppImage.
- The app's purpose is running commands in the user's terminals. Whatever can ship an update can
  run code on every user's machine. The trust root is the GitHub account and whoever can push tags
  and publish releases.

## Options
| Option | Strengths | Weaknesses |
|---|---|---|
| A. **Notify only**: ask the GitHub API for the latest release, and link to it | No dependency; same on every OS; nothing installs itself | Still a manual download and install |
| B. **`electron-updater`** on Windows and Linux, notify-only on macOS | Real one-click updates where the OS allows; uses feeds already published | New dependency; two paths to maintain |
| C. B plus signing and notarizing for macOS | One-click updates everywhere | Paid Apple Developer account; signing secrets in CI |
| D. update.electronjs.org | Free hosted service for public repos | Needs Squirrel.Windows (not NSIS) and signed macOS builds; doesn't fit |
| E. Self-replace on macOS (mount the DMG, copy over `/Applications`, clear quarantine) | One-click on macOS without signing | Fragile; works around Gatekeeper rather than with it |

## Proposal
Phase 1 is A, now built. B is phase 2. Leave C for when signing is done for its own reasons. Rule out D and E.

### Phase 1: notify (all OSes, no new dependency). Built.
- Main checks `https://api.github.com/repos/ix9/AirlockTerminal/releases/latest` 10 seconds after
  start and then every 6 hours. Unauthenticated, that's far under the 60 requests an hour limit.
  Only published, non-prerelease releases are returned. No user or machine details are sent.
- If its tag is newer than `app.getVersion()`, the status bar shows **Update 0.5.0 available**.
  Clicking it opens a native dialog with the release notes as plain text, how to install on this
  OS, and:
  - **Download**, which opens the installer for this OS and processor in the browser
    (`AirlockTerminal-<ver>-<os>-<arch>.<ext>`, the artifact names in `package.json`). An Intel
    copy running under Rosetta is offered the Apple silicon build. Only addresses under
    `github.com/ix9/AirlockTerminal/releases/` are ever opened;
  - **Release Notes**, which opens the release page;
  - **Skip This Version**, which hides the notice until a newer version is out;
  - **Later**.
- Settings has **Check GitHub for new versions** (on by default), **Check now**, and the result
  of the last check. Check now also brings back a skipped version. The DEV copy only checks when
  Check now is pressed.
- Failed checks are silent apart from that Settings line.

### Phase 2: install in place (Windows and Linux)
- Add `electron-updater`, pinned, and list it in DEPENDENCIES.md. `autoDownload` stays off;
  `autoInstallOnAppQuit` stays off.
- The same status bar item offers **Download and restart**. It downloads, using the blockmap for a
  small delta, checks the sha512, and asks before restarting. Restarting closes terminals, so the
  prompt says so, and the existing unsaved-Runsheet check still runs.
- macOS keeps the Phase 1 flow.
- Since an update is code from the release, protect it: require 2FA on the account, protect
  `v*` tags, and keep the release a draft until it has been tried.

### Phase 3 (only with signing)
Sign and notarize the macOS build in CI, add the `zip` target, and turn Phase 2 on for macOS too.

## Consequences
- Phase 1 changes nothing about how releases are made.
- Phase 2 means a published release reaches Windows and Linux users in one click. A bad release
  spreads faster, so pull a bad release by unpublishing it (back to draft). Clients then see the
  previous one as latest again.
- Nothing installs without the user pressing a button, in keeping with the app's "nothing runs on
  its own" rule.
