# Objective

## What
Airlock Terminal is a cross-platform desktop app (Windows, macOS, Linux) that puts a web chat
and a real terminal in one window, with an "airlock" scratchpad between them:

- **Right pane:** claude.ai in an embedded browser with its own persistent session. You log in
  once.
- **Left pane:** an interactive terminal. You choose the shell from the toolbar: PowerShell or
  a WSL distro on Windows, the shells in `/etc/shells` and `pwsh` on macOS and Linux.
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
4. Ctrl+Enter in the airlock sends its text to the terminal. Nothing runs without an explicit
   action: that, or a deliberate double-copy ([ADR 0005](adr/0005-double-copy.md)).
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

## Iteration 3
- **Scratchpad:** a tab that takes over the terminal area (the shell keeps running underneath)
  for long snippets. **Execute** runs the highlighted text in the terminal, **Save** writes a
  text file to the terminal's current directory, and **Split** gives two panes that can be
  compared side by side. Both panes and the split are kept between sessions.
- **Terminal tabs:** each tab has its own shell, working directory, env strip and AWS selection.
  The airlock and scratchpad are shared and act on the active terminal
  ([ADR 0004](adr/0004-tabs-and-saved-state.md)).
- **Themes:** Airlock (the default, from the app icon), Dark Modern, Light Modern, high contrast,
  Monokai, Oceanic Next, or following the system ([ADR 0011](adr/0011-refined-layout.md)).
- **Runsheet:** a tab beside Claude listing the files in a chosen folder. Scripts open in an
  editor with syntax highlighting, where Ctrl+Enter runs the highlighted text or the block at the
  cursor ([ADR 0009](adr/0009-runsheet-editor.md)). Markdown opens as a formatted page, with its
  source a click away. Copying from either fills the airlock, as copying in the chat does, and
  **Append to Runsheet** adds the airlock text to the end of the open file.
- **Web tab:** a small browser beside Claude, for pages such as Confluence. Copying from a page
  fills the airlock.
- **Double-copy:** copying the same text twice quickly, from the chat, a runsheet or a Web tab site
  with Auto-run on, also runs it
  ([ADR 0005](adr/0005-double-copy.md)).
- **Status bar** across the bottom of the window.
- **Settings** are remembered: window size, divider positions, font size, last shell and theme.
- **Saved terminal output** (opt-in) restores tabs and their output after a restart.
- **Snippets folder:** snippets can live in a git or synced folder.
- **Installers** for Windows, macOS and Linux, on GitHub Releases. Since 0.6 the macOS build is
  signed and notarized; Windows is still unsigned.

## Iteration 4
- **Command palette** (⌘K / Ctrl+Shift+K): one search across this tab's commands, airlock history,
  snippets and Runsheet lines, with **Ask AI** first. A local model (LM Studio and similar, default
  `http://localhost:1235/v1`) turns a description into a command. ↵ runs it and ⌘↵ puts it in the
  airlock; one that deletes data always goes to the airlock ([ADR 0012](adr/0012-command-palette.md)).
- **Inline suggestions:** grey text after the cursor as you type, from this tab's and the airlock's
  history and, if turned on, the local model. → accepts; nothing runs until Enter. Stacked or List
  style, with toolbar toggles for each source ([ADR 0013](adr/0013-inline-suggestions.md)).
- **Fold the side pane** into an icon rail for a full-width terminal, from the title bar button,
  the handle on the divider or ⌘\ ([ADR 0014](adr/0014-fold-side-pane.md)).

## Out of scope (for now)
- Using an existing browser profile.
- Running commands without a deliberate user action, or parsing chat content beyond copy events.
- Plugins.
- SSH from the shell picker. Running `ssh` by hand works, without cwd or env reporting.
- File editing beyond the Runsheet (Wave-style).
- Installing updates automatically. The app says when a newer release is out and links to it
  ([ADR 0010](adr/0010-updates-from-github-releases.md)); one-click updates are proposed there.
