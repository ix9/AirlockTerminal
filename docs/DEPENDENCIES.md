# Dependencies

All versions are pinned exactly in `package.json`.

| Dependency | Version | Purpose | Licence |
|---|---|---|---|
| electron (dev) | 45.2.3 | App shell, Chromium, `WebContentsView` | MIT |
| electron-builder (dev) | 26.18.0 | Builds the installers | MIT |
| node-pty | 1.1.0 | Pseudoterminal (ConPTY / Unix pty) | MIT |
| @xterm/xterm | 6.0.0 | Terminal renderer | MIT |
| @xterm/addon-fit | 0.11.0 | Fits the terminal to its pane | MIT |
| @xterm/addon-web-links | 0.12.0 | Clickable URLs in the terminal | MIT |
| @xterm/addon-serialize | 0.14.0 | Saves terminal output between sessions (opt-in) | MIT |
| @xterm/addon-unicode-graphemes | 0.4.0 | Unicode 15 character widths, so emoji in prompts line up with the shell | MIT |
| @highlightjs/cdn-assets | 11.11.1 | Syntax highlighting in the Runsheet | BSD-3-Clause |
| marked | 18.1.1 | Formats Markdown runsheets | MIT |
| dompurify | 3.4.17 | Sanitizes formatted Markdown | MPL-2.0 OR Apache-2.0 |
| Node.js (dev) | 24.x | Running npm and Electron in development | MIT |

Shells (provided by the OS): `pwsh` / `powershell.exe` and `wsl.exe` on Windows, and the
shells in `/etc/shells` on macOS and Linux.

`git` on the PATH, for Team snippets only ([ADR 0006](adr/0006-team-snippets.md)). It uses the
person's own git sign-in (Git Credential Manager or SSH keys).

External services: **claude.ai**, loaded in the chat pane. The main process also reads
claude.ai's usage endpoint with the same session ([ADR 0003](adr/0003-claude-usage-stats.md)).
Other network calls: the team snippets repo set in Settings (through `git`), the Web tab loads the addresses you enter (text that isn't an address is sent
to Google as a search), and Markdown runsheets load any remote images they contain.

Local files read: `~/.aws/config` (profile names only), the names and contents of files in the chosen Runsheet folder, and the `README.md` of the git repository the terminal is in (its code blocks become snippets). Files written in the app's user data
folder: `settings.json`, `snippets.json` (or in a folder chosen in Settings), `team-snippets/` (a clone of the team repo), and, readable only
by the user, `history.jsonl`, `scratchpad.json` and `scrollback.json` (only if turned on).
