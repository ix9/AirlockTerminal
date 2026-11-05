# Dependencies

All versions are pinned exactly in `package.json`.

| Dependency | Version | Purpose | Licence |
|---|---|---|---|
| electron | 45.2.3 | App shell, Chromium, `WebContentsView` | MIT |
| node-pty | 1.1.0 | Pseudoterminal (ConPTY / Unix pty) | MIT |
| @xterm/xterm | 6.0.0 | Terminal renderer | MIT |
| @xterm/addon-fit | 0.11.0 | Fits the terminal to its pane | MIT |
| @xterm/addon-web-links | 0.12.0 | Clickable URLs in the terminal | MIT |
| Node.js (dev) | 24.x | Running npm and Electron in development | MIT |

Shells (provided by the OS): `pwsh` / `powershell.exe` and `wsl.exe` on Windows, and the
shells in `/etc/shells` on macOS and Linux.

External services: **claude.ai**, loaded in the chat pane. The main process also reads
claude.ai's usage endpoint with the same session ([ADR 0003](adr/0003-claude-usage-stats.md)).
The app makes no other network calls.

Local files read: `~/.aws/config` (profile names only). Files written in the app's user data
folder: `snippets.json`, `history.jsonl`.
