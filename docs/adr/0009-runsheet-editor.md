# ADR 0009: The Runsheet is always editable

**Status:** Accepted
**Date:** 2026-11-17

## Context
The Runsheet had two modes. The read view had syntax highlighting, line numbers and per-block
Copy and Run buttons. Edit swapped it for a plain textarea, with Save and Cancel. Working through
a PowerShell or bash script means fixing a line and running it, again and again, and every switch
between the modes broke that rhythm. The user wants to edit and run in the same place: a block, or
just the highlighted part, whenever they like.

## Options
| Option | Strengths | Weaknesses |
|---|---|---|
| Monaco (VS Code's editor) | Everything: find, multi-cursor, folding | About 5 MB; its own workers, themes and loader; far more than a runsheet needs |
| CodeMirror 6 | Smaller, modular | A new set of packages to pin and review; its own theming beside ours |
| **A see-through textarea over the highlighted text (chosen)** | No new dependency; the browser's own typing, undo, IME and selection; keeps the existing gutter, bands and highlight.js | No find-in-file or multi-cursor; highlights the whole file on every keystroke |

## Decision
- The textarea sits exactly over a highlighted copy of the same text, with the same font, line
  height and tab size. Its text is transparent; only the caret and selection show. The textarea is
  as big as its text, so the pane scrolls rather than the textarea, and the line numbers, block
  bands and the highlighted copy all scroll with it.
- **Ctrl/Cmd+Enter** (as in the airlock) and **F8** (as in the PowerShell ISE and VS Code) run the
  highlighted text or, with nothing highlighted, the block the cursor is in. Blocks are still runs
  of lines between blank lines. The **Run** button in the bar does the same, and the hover buttons
  on each block still work.
- What runs is what's on screen, saved or not.
- **Save** (Ctrl/Cmd+S) is enabled whenever the text differs from the file. The file name and the
  Runsheet tab show `•` while it does. Saving still asks before overwriting a file that changed on
  disk, and keeps the file's encoding and line endings. **Reload** reads the file again, asking
  first if there are unsaved changes. Opening another file or folder asks the same.
- Markdown opens as the formatted page, as before. **Source** shows the same editor on its
  Markdown; **Preview** goes back, showing unsaved changes.
- Files that aren't valid UTF-8 or UTF-16 open read-only, since saving them could change bytes.
- Copying from the editor still fills the airlock, and double-copy still runs (ADR 0005). Cutting
  doesn't.

### Append to Runsheet
The airlock's **Append to Runsheet** button adds its text to the end of the open file, after a
blank line so it becomes a block of its own. In a Markdown file it goes in as a fenced code block,
tagged `powershell` or `bash` from the active terminal, so the formatted page gives it Run buttons.
Like any other edit, it waits unsaved until Save; Undo in the editor takes it out. The right pane
stays on whatever tab it was showing, so commands can be collected from the chat without switching
back and forth.

## Consequences
- No find-in-file, multi-cursor or code completion. If those become wanted, CodeMirror 6 is the
  next step. It can take over the same text and keep the rest of this design.
- Very large files (the limit is 2 MB) re-highlight slowly on every keystroke.
- Unsaved edits are lost if the app crashes. Closing the window asks first, as before.
