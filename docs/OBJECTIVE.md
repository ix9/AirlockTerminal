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

## Out of scope (for now)
- Using an existing browser profile.
- Running commands automatically, or parsing chat content beyond copy events.
- Tabs, themes, plugins, multiple terminals.
- File editing (Wave-style). Possible later, as its own ADR.
