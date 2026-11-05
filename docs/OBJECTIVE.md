# Objective

## What
Airlock Terminal is a cross-platform desktop app (Windows, macOS, Linux) that puts a web chat
and a real terminal in one window, with an "airlock" scratchpad between them:

- **Right pane:** claude.ai in an embedded browser with its own persistent session. You log in
  once.
- **Left pane:** an interactive terminal. You choose the shell from the toolbar: PowerShell or
  a WSL distro on Windows, the shells in `/etc/shells` on macOS and Linux.
- **Airlock** (below the terminal): anything copied in the chat lands here automatically. You
  review and edit it, then send it to the terminal with **Run** / `Ctrl+Enter`.

## Why
Running commands from a chat means copying, tweaking and pasting between separate windows.
Commands from a chat should be checked before they run. The airlock puts that check step in
the middle of the workflow without slowing it down.

## Done looks like
1. Opening the app shows claude.ai on the right, still logged in from the last session.
2. The left pane is a fully interactive shell, with colours, TUIs and Ctrl+C working, and the
   shell can be switched from the toolbar.
3. Copying in the chat (the code-block copy button or Ctrl+C) fills the airlock.
4. Ctrl+Enter in the airlock sends its text to the terminal. Nothing runs without that
   explicit action.
5. Window size, divider positions and the last shell are remembered between sessions.
6. Installers for Windows and macOS (Linux AppImage if feasible), published on GitHub
   Releases.

## Iteration 2
- URLs in the terminal are clickable. Terminal text zooms with Ctrl/Cmd + `=` / `-` / `0`
  and Ctrl+wheel.
- **Snippets:** a saved collection of commands. Picking one loads it into the airlock.
- **History:** every command run from the airlock is kept, and can be reloaded from the list.
- **AWS profiles:** a picker listing the profiles in `~/.aws/config`. Choosing one sends the
  right command for the shell (`$env:AWS_PROFILE = '…'` or `export AWS_PROFILE='…'`).
- **Environment panel:** variables changed in this terminal session, at the top left of the
  terminal ([ADR 0002](adr/0002-shell-integration.md)).
- **Downloads** from the chat pane auto-save into the terminal's current directory.
- **Usage stats:** Claude session and weekly usage in the title bar
  ([ADR 0003](adr/0003-claude-usage-stats.md)).
- **VS Code-style window:** a custom dark title bar instead of the native one.

## Out of scope (for now)
- Using an existing browser profile.
- Running commands automatically, or parsing chat content beyond copy events.
- Tabs, themes, plugins, multiple terminals.
- File editing (Wave-style). Possible later, as its own ADR.
