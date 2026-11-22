# Airlock Terminal

Airlock Terminal puts a web chat (claude.ai) and a real terminal in one window, with an airlock
between them. Anything you copy in the chat lands in the airlock. You check it, edit it, and
send it to the shell with `Ctrl+Enter`. Nothing runs until you say so: press Run, or copy the same
text twice quickly (this can be turned off in Settings).

Runs on Windows, macOS and Linux.

> Status: early development. See [docs/OBJECTIVE.md](docs/OBJECTIVE.md).

## Run from source
Requires Node.js 24+. On Linux, also `python3`, `make` and `g++` (to build node-pty).

```sh
npm install
npm start
```

The first `npm start` downloads Electron, because Electron's npm package fetches its binary on
first use rather than during `npm install`.

A copy run from source keeps its settings and data in its own folder (`airlock-terminal-dev`
beside the installed app's), so it runs alongside an installed copy. It shows a DEV badge in the
title bar and needs its own claude.ai sign-in.

## Installers
`npm run dist` builds an installer for the current OS in `dist/`. Pushing a `v*` tag builds all
three on GitHub Actions and attaches them to a draft release: a DMG for Apple silicon Macs, an
installer for 64-bit Windows, and an AppImage for 64-bit Linux.

The app icon's files are in `build/` (macOS `.icns`, Windows `.ico`, Linux PNGs). Their source
SVGs are `src/assets/icon.svg` and `src/assets/icon-macos.svg`.

**macOS** builds are signed with a Developer ID and notarized by Apple, so they open without a
warning. Tag builds sign in GitHub Actions, using five repo secrets: `MAC_CERT_P12_BASE64`,
`MAC_CERT_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. Only the
signing step of a `v*` tag build can see them. Locally, `npm run dist` signs with a Developer ID
in your keychain, if there is one.

**Windows** builds are unsigned: in the SmartScreen prompt, choose **More info > Run anyway**.

## Docs
- [Objective](docs/OBJECTIVE.md)
- [ADR 0001: Electron + node-pty + xterm.js](docs/adr/0001-electron-node-pty-xterm.md)
- [ADR 0004: Terminal tabs and saved state](docs/adr/0004-tabs-and-saved-state.md)
- [ADR 0005: Double-copy runs a command](docs/adr/0005-double-copy.md)
- [ADR 0007: Command blocks](docs/adr/0007-command-blocks.md)
- [ADR 0008: Remote sessions](docs/adr/0008-remote-sessions.md)
- [ADR 0009: The Runsheet is always editable](docs/adr/0009-runsheet-editor.md)
- [ADR 0010: Updates from GitHub Releases](docs/adr/0010-updates-from-github-releases.md)
- [ADR 0011: Refined layout and the Airlock theme](docs/adr/0011-refined-layout.md)
- [ADR 0012: Command palette with Ask AI](docs/adr/0012-command-palette.md)
- [ADR 0013: Inline suggestions as you type](docs/adr/0013-inline-suggestions.md)
- [ADR 0014: Folding the side pane to an icon rail](docs/adr/0014-fold-side-pane.md)
- [Dependencies](docs/DEPENDENCIES.md)

## Licence
[MIT](LICENSE)

Airlock Terminal is an independent project, not affiliated with or endorsed by Anthropic.
