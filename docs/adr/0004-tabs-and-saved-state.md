# ADR 0004: Terminal tabs and saved state

**Status:** Accepted
**Date:** 2026-11-05

## Context
One terminal isn't enough, and everything was lost on restart: window layout, scratchpad text and
terminal output. Some of that data is sensitive, because terminals and scratchpads hold secrets.

## Decision
**Tabs.** The main process keeps a map of terminals keyed by a tab id from the UI, and the renderer
keeps one xterm.js per tab. All terminals stay laid out at full size and inactive ones use
`visibility: hidden`, so background shells never see a resize and can't take keyboard focus. The
airlock and scratchpad are shared and act on the active terminal, or the last active one while an
overlay is showing. Downloads, saves and the AWS picker follow it too.

**Closing a tab** asks first if a process other than the shell is in the foreground. Windows and WSL
can't report this, so there it always asks unless the shell has exited.

**Shortcuts** are Cmd on macOS and Ctrl+Shift elsewhere, because the shell uses plain Ctrl+T and
Ctrl+W.

**Files**

| File | Contents | Permissions | Location |
|---|---|---|---|
| `settings.json` | Window, dividers, font size, last shell, theme | Default | User data |
| `snippets.json` | Saved commands | Default | User data, or a chosen folder |
| `history.jsonl` | Commands run, trimmed to 500 on startup | User only | User data |
| `scratchpad.json` | Both panes and the split | User only | User data |
| `scrollback.json` | Open tabs and up to 5,000 lines each, opt-in | User only | User data |

Only snippets can move to a synced folder, because the others are the most likely to hold secrets.
A snippets file that can't be parsed, such as one with git conflict markers, is reported and never
overwritten. If two machines edit at once, the last save wins.

**Saved output** is off by default, because anything printed on screen ends up on disk. It restores
tabs and their text under a "restored" line, with a new shell in each tab. Running processes can't
be restored, and full-screen programs' screens aren't saved.

## Consequences
- Memory use grows with the number of tabs: each keeps up to 5,000 lines of scrollback.
- A background tab's output is saved at most 30 seconds late, so a crash can lose the latest output.
  A normal quit saves everything.
