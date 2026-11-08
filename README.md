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

## Installers
`npm run dist` builds an installer for the current OS in `dist/`. Pushing a `v*` tag builds all
three on GitHub Actions and attaches them to a draft release.

Builds are unsigned, so each OS warns on first launch:
- **macOS:** the build is ad-hoc signed, so downloaded copies get blocked. Open the app once from
  **System Settings > Privacy & Security > Open Anyway**.
- **Windows:** in the SmartScreen prompt, choose **More info > Run anyway**.

## Docs
- [Objective](docs/OBJECTIVE.md)
- [ADR 0001: Electron + node-pty + xterm.js](docs/adr/0001-electron-node-pty-xterm.md)
- [ADR 0004: Terminal tabs and saved state](docs/adr/0004-tabs-and-saved-state.md)
- [ADR 0005: Double-copy runs a command](docs/adr/0005-double-copy.md)
- [ADR 0007: Command blocks](docs/adr/0007-command-blocks.md)
- [ADR 0008: Remote sessions](docs/adr/0008-remote-sessions.md)
- [Dependencies](docs/DEPENDENCIES.md)

## Licence
[MIT](LICENSE)

Airlock Terminal is an independent project, not affiliated with or endorsed by Anthropic.
