# ADR 0011: Refined layout and the Airlock theme

**Status:** Accepted
**Date:** 2026-11-18

## Context
The app has a new icon: navy, with a cyan ring and a yellow spark. The UI still looked like
VS Code's defaults, with flat panels, upper-case tabs and a row of text buttons. The airlock header
also wrapped to two rows at half the window's width once Append to Runsheet was added.

Three directions were mocked up:
- **Refined:** the same layout, polished.
- **Composer:** the airlock as a command bar under the terminal, a ⌘K palette and an icon rail.
- **Workspace:** a light, sidebar-based macOS layout.

Refined was chosen. Composer is kept for later: its ⌘K palette and command bar may be added piece
by piece.

## Decision
**Layout (every theme):**
- Rounded cards for the terminal, the airlock, and each pane on the right. The Claude and Web
  views are native, so main rounds them with `setBorderRadius` to match.
- Tabs become segmented controls in sentence case: Local Snippets / History, and the right pane.
  Terminal tabs in the title bar become pills. A PROD tab gets a red outline.
- Icon buttons with tooltips in the terminal toolbar: Restart, Copy last, Send to Claude,
  Scratchpad and Settings. Find shows its shortcut.
- **Airlock header:** Run selection and Run, with their shortcuts, then a ⋯ menu holding Paste,
  Clear, Save snippet…, Save to repo… and Append to Runsheet. The header no longer wraps.
- Shortcut hints are added from `data-keys` and spelled for the platform: `⇧⌘↵` on macOS,
  `Ctrl+Shift+Enter` elsewhere.
- **One Snippets tab** in place of Team Snippets and Personal Snippets. Its filter offers All,
  Team, Personal or a single repo. A new snippet starts in whatever the filter shows. A saved
  `rightTab` of `team` or `personal` opens Snippets.

**Airlock theme:** navy surfaces, cyan (`#22D3EE`) for actions and focus, and spark yellow
(`--spark`) for things worth noticing, such as the update notice. The terminal has a matching
ANSI palette in `themes.js`.
- It's the default for new installs. **Follow system** uses it when the system is dark.
- An existing `theme: "dark"` (the old default) moves to Airlock once, marked with
  `airlockThemeOffered`. Picking Dark Modern again after that sticks.
- Three variables carry the cards in every theme: `--term-bg` (the terminal and editor),
  `--surface` (the airlock card and the segmented trays) and `--edge` (outlines). Each theme can
  override them; by default they follow its existing colours.

## Consequences
- Every theme gets the new layout; only the colours differ.
- Anyone who had deliberately chosen Dark Modern is moved to Airlock once, and has to choose
  Dark Modern again.
