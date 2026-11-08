# ADR 0007: Command blocks from OSC 133 marks

**Status:** Accepted
**Date:** 2026-11-08

## Context
**Copy last** and **Send to Claude** take the last command and its output and put them in a chat
as a Markdown code block. Hovering over any command in the terminal offers the same two actions
for that command. That needs to know where in the terminal's output a command starts,
where its output starts and ends, and how it exited. The terminal on its own sees only a stream of
text. Later features (exit-status badges, jumping between prompts) need the same thing.

## Options
| Option | Strengths | Weaknesses |
|---|---|---|
| Guess from the text (look for a prompt pattern) | No shell changes | Breaks with every prompt theme; two-line prompts |
| Track what the app sends and where Enter is pressed | No shell changes | Wrong for pasted or queued input, since the shell's echo arrives later |
| **Shell marks (chosen)**, OSC 133 as used by VS Code, iTerm2, WezTerm and Windows Terminal | Exact; a standard that remote shells may already send | More in each integration script |

## Decision
The integration scripts from [ADR 0002](0002-shell-integration.md) also send the standard
OSC 133 marks, and our private OSC 7337 carries the command line:

```
ESC ] 133 ; D ; <exit> BEL        the last command has finished (sent at every prompt)
ESC ] 133 ; A BEL                 a prompt starts
ESC ] 7337 ; cmd ; base64(cmd) BEL   the command line, just before it runs
ESC ] 133 ; C BEL                 its output starts
```

- **zsh:** `preexec` sends the command line and C. A `precmd` hook, put first so it reads the
  real `$?`, sends D and A and returns the same status for the hooks after it.
- **bash 4.4+:** `PS0` sends the command line (from `history 1`) and C. On bash 3.2 (macOS)
  the DEBUG trap does it instead, unless something like bash-preexec already uses that trap.
- **PowerShell:** the wrapped `prompt` sends D and A. Wrapping `PSConsoleHostReadLine`, as VS Code
  does, sends the command line and C. `$?` is put back with `Write-Error -ErrorAction Ignore`, so
  the user's own prompt still sees a failure.

The renderer keeps a list of blocks per tab (the last 200), with positions held as xterm.js
markers. They follow their line as output scrolls, and are disposed when it leaves the scrollback.
D is ignored unless a command started, because shells also send it after an empty Enter.

When the shell doesn't send C or the command line (history left it out, or some other
integration owns the DEBUG trap), the renderer falls back to where the first key was typed at the
prompt and where Enter was pressed. B (input starts), sent by other integrations, is used the
same way.

**Send to Claude** writes the block to the clipboard, focuses claude.ai's message box and pastes.
That's what a person would do, so long output becomes an attachment as it does for them. It
never presses Enter: the person adds their question and sends it.

## Consequences
- Blocks appear in zsh, bash and PowerShell started by the app. Over ssh, or in other shells,
  there are none unless the remote side sends OSC 133 itself.
- Output restored from a previous session has no blocks.
- If claude.ai changes its message box, Send to Claude can't find it: the text stays on the
  clipboard and the app says so.
