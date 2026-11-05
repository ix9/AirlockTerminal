# ADR 0001: Electron + node-pty + xterm.js

**Status:** Accepted
**Date:** 2026-11-05

## Context
We need one window holding an external web chat (claude.ai), an interactive terminal and a
scratchpad (the "airlock") that captures copies made in the chat and sends edited text to the
terminal. It must run on Windows, macOS and Linux.

A Windows-only WPF + WebView2 prototype (ChatTerm) proved the layout and the copy capture, but
it can't run on macOS or Linux.

### Build vs buy
| Option | Strengths | Weaknesses |
|---|---|---|
| Browser + terminal side by side | Free, no code | Two windows, no airlock |
| Wave Terminal (OSS) | Terminal, web and editor blocks in one window | No copy → scratchpad → run flow, a large app to bend to one workflow |
| Build (chosen) | Exactly the workflow, small codebase | We maintain it |

### Cross-platform shell
| Option | Strengths | Weaknesses |
|---|---|---|
| **Electron** (chosen) | node-pty + xterm.js is VS Code's terminal stack, so it's heavily proven. `WebContentsView` hosts an external site beside local UI. Same engine (Chromium) on every OS. | ~150 MB install, higher memory use |
| Tauri v2 | Small, light | Multiple webviews in one window is still an unstable feature. A different engine on each OS (WebKitGTK on Linux), so claude.ai behaviour varies. Rust. |
| .NET WPF | Already prototyped | Windows only |

## Decision
- **Electron**, plain JavaScript (CommonJS), no framework and no bundler.
- **Chat pane:** a `WebContentsView` loading `https://claude.ai/` in the persistent session
  partition `persist:chat`, laid over a placeholder area of the local UI. Its bounds follow
  the placeholder, so the divider is plain HTML. Links that open new windows go to the
  system browser.
- **Terminal:** **xterm.js** in the local UI renderer, connected over IPC to **node-pty** in the
  main process. node-pty uses ConPTY on Windows and a Unix pty on macOS and Linux.
- **Copy capture:** a sandboxed preload for the chat pane uses
  `contextBridge.executeInMainWorld` to wrap `navigator.clipboard.writeText` / `write` before
  page scripts run, and listens for the DOM `copy` event. Text goes to the main process, which
  accepts it only from frames on `claude.ai` and forwards it to the airlock. These are
  standard web APIs, so the capture doesn't depend on claude.ai's page layout.
- **Sending to the terminal:** the airlock text is written to the pty wrapped in
  bracketed-paste markers, followed by Enter, and only on an explicit Run / Ctrl+Enter.
- **Security:** both renderers use `contextIsolation`, `sandbox` and no `nodeIntegration`. Only
  the main process touches node-pty.

## Consequences
- Not the user's real browser profile. They log in once inside the app.
- claude.ai page scripts could call the exposed copy hook. The worst case is text appearing in
  the airlock, which never runs without Ctrl+Enter.
- node-pty ships prebuilt binaries for Windows and macOS. Linux needs build tools
  (`python3`, `make`, `g++`) at `npm install`.
- Future file editing (for example Monaco) fits the same renderer model and will get its own
  ADR.
