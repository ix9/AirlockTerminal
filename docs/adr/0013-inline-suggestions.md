# ADR 0013: Inline suggestions as you type

**Status:** Accepted
**Date:** 2026-11-22

## Context
The command palette (ADR 0012) finds and writes commands, but it means stopping to open it. Most
of the time the command you're typing is one you've run before, or one a small model can finish.
fish and zsh-autosuggestions show that as grey text after the cursor. Airlock can do the same for
every shell it runs, using history it already keeps and the local model from Ask AI.

## Options
| Option | Strengths | Weaknesses |
|---|---|---|
| **Draw over the terminal (chosen)** | Every shell the app runs, the same way; the shell never sees a suggestion until it's accepted | Has to read the line off the screen, so some cases are skipped |
| The shells' own systems (zsh-autosuggestions strategies, PowerShell predictors) | Native rendering and editing | One build per shell, and bash has no real support |

## Decision
**Reading the line.** The prompt ends where the first key typed at it landed (the same mark as
command blocks, ADR 0007). The line runs from there to the cursor. Suggestions only show when:
- the cursor is at the end of the line, with nothing after it but a right-hand prompt well clear
  of it;
- it's a single line, perhaps wrapped;
- the terminal is at the bottom of its scrollback, in its normal screen (not vim, less or top);
- the terminal has focus.

Text right after the cursor means something else is drawing there: the line itself, or another
tool's suggestion (zsh-autosuggestions, PowerShell's predictions). In that case these step aside.

**Sources.**
- **History:** the newest command starting with what's typed, from this tab's commands and then
  the airlock's history. Instant; on by default.
- **AI:** the model from Ask AI, asked once typing pauses (300 ms by default; Settings). It's sent
  the line, the shell, the OS, the folder and this tab's last five commands. Only completions that
  start with exactly what's typed are kept, cut to the rest of that one line with control
  characters removed. Off by default.
- **Nothing that deletes.** The model isn't asked about a line that already deletes or overwrites
  data (`rm`, `dd`, `Remove-Item`, `> file` and so on, the patterns from ADR 0012), and any
  completion that would make the line do so is dropped.
- **When the server is down,** asking pauses for 30 seconds rather than failing on every keystroke.

**Accepting** types the rest into the shell exactly as typing would. It can't contain a newline or
control character, so it never presses Enter: only what's on the line runs, when you press Enter.

**Two styles, chosen in Settings:**
- **Stacked** (the default): history in grey after the cursor, accepted with **→**. The model's
  suggestion, when it differs, goes on a faint line underneath (above, on the bottom row),
  accepted with **⇧→**. With only one source, it's the grey text and → accepts it. When history
  and the model agree, there's one suggestion marked as both.
- **List:** a small list above the line, history then AI, with each AI entry's risk label.
  **↑↓** choose (the grey text follows), **→** accepts, **esc** hides it until the line changes.
  While it's open, ↑↓ belong to the list, not the shell's history.

**Ctrl+Space** opens or closes the list in either style. **Toolbar:** a history book and the AI
spark switch each source on and off, lit when on and struck through when off. They're the same
settings as the switches in Settings → Inline suggestions.

## Consequences
- No suggestions in shells without the shell integration (most SSH sessions without it), or
  while typing over several lines, or editing in the middle of a line.
- Ctrl+Space no longer reaches the shell (it's set-mark in emacs mode).
- → at the end of a line with a suggestion accepts it instead of doing nothing.
- The toolbar has two more buttons. On narrower panes the shell picker narrows first, then Restart
  and Scratchpad drop their labels, then Find's toggles hide, so it stays on one row.
