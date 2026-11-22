# ADR 0014: Folding the side pane to an icon rail

**Status:** Accepted
**Date:** 2026-11-22

## Context
The right-hand pane (Claude, Web, Runsheet, Snippets, Remotes) takes about half the window. Some
work needs the whole width for the terminal: wide `kubectl -o wide` tables, logs, full-screen
programs. Dragging the divider each time is slow, and you lose the width you had.

Three ways were mocked up: a title bar button, a handle on the divider, and folding into an icon
rail. The user chose the rail, reached two ways: the title bar button and the handle.

## Decision
- **Folded**, the pane becomes a 48px rail of its tabs' icons: Claude, Web, Runsheet, Snippets,
  Remotes. The current tab is lit, and a dot marks unsaved Runsheet changes. Clicking an icon
  opens the pane on that tab.
- **Three ways to fold and open it:**
  - the **title bar button** (far right; its right half is filled while the pane is open);
  - the **handle on the divider** (a pill, › when open, ‹ when folded);
  - **⌘\\** on macOS, **Ctrl+Shift+\\** elsewhere (plain Ctrl+\\ is the shell's quit signal).
- **Dragging the divider** to within 90px of the window's right edge folds the pane. The divider
  turns yellow just before it does, and it keeps the width it had before the drag, for when it
  opens again.
- **Anything that shows something in the pane opens it:** Send to Claude, Save to repo, the
  palette's Ask in chat.
- **While folded,** the Claude and Web pages, which are native views over the window, are hidden,
  not just covered, and the divider can't be dragged.
- Folded or open is remembered (`sideFolded`).

## Consequences
- Folding resizes the terminal at once, with no animation. Resizing it on every frame of an
  animation would make the shell redraw its prompt many times.
- The handle has to stay within the 8px gap before the chat's native view, which is drawn over
  the page and would cover anything further right.
