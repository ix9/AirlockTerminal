# Airlock Terminal

Airlock Terminal puts a web chat (claude.ai) and a real terminal in one window, with an airlock
between them. Anything you copy in the chat lands in the airlock. You check it, edit it, and
send it to the shell with `Ctrl+Enter`. Nothing runs until you say so.

Runs on Windows, macOS and Linux.

> Status: early development. See [docs/OBJECTIVE.md](docs/OBJECTIVE.md).

## Run from source
Requires Node.js 24+. On Linux, also `python3`, `make` and `g++` (to build node-pty).

```sh
npm install
npm start
```

## Docs
- [Objective](docs/OBJECTIVE.md)
- [ADR 0001: Electron + node-pty + xterm.js](docs/adr/0001-electron-node-pty-xterm.md)
- [Dependencies](docs/DEPENDENCIES.md)

## Licence
[MIT](LICENSE)

Airlock Terminal is an independent project, not affiliated with or endorsed by Anthropic.
