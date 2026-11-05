# ADR 0002: Shell integration via a prompt hook

**Status:** Accepted
**Date:** 2026-11-05

## Context
Two features need to know what is happening inside the shell:
- The **environment panel** lists variables that have changed in this terminal session,
  including ones the user typed by hand.
- **Downloads** from the chat pane are saved into the terminal's **current directory**.

Neither can be worked out from outside: the pty doesn't expose the shell's cwd or environment
on all platforms (and not at all for WSL).

## Options
| Option | Strengths | Weaknesses |
|---|---|---|
| Only track what the app sends (AWS picker, airlock) | No shell changes | Misses manual `export` / `cd`; no reliable cwd |
| Poll the OS for the process cwd/env | No shell changes | Not possible on Windows/WSL; env of a running process isn't readable |
| **Prompt hook (chosen)**, the same approach as VS Code's shell integration | Accurate after every command; covers manual changes | We inject a small script per shell |

## Decision
On start, each shell gets a small integration script that runs **after** the user's own
profile/rc, so prompt themes (oh-my-posh, starship, p10k) keep working. On every prompt it
emits a private OSC sequence:

```
ESC ] 7337 ; airlock ; base64(cwd) ; base64(KEY=VALUE pairs separated by NUL) BEL
```

NUL-separated pairs, rather than JSON, can be produced with shell built-ins alone (`compgen -e`
in bash, `$parameters` in zsh, `[Environment]` in PowerShell). That avoids depending on
`jq`, `python` or `env -0`, which macOS lacks.

- **pwsh / Windows PowerShell:** `-NoExit -Command ". '<integration.ps1>'"`. The script wraps
  the existing `prompt` function.
- **bash (incl. WSL):** `--rcfile <integration.bash>`. The script sources `~/.bashrc`, then
  appends to `PROMPT_COMMAND`. For WSL the path is passed in `/mnt/<drive>/…` form.
- **zsh:** `ZDOTDIR` points at a folder whose `.zshrc` restores the user's `ZDOTDIR`, sources
  their `.zshrc`, then adds a `precmd` hook.
- Other shells run without integration: no env panel and downloads fall back to the
  Downloads folder.

The renderer registers an xterm.js OSC handler for `7337` on each terminal, which hides the sequence from the
display. It diffs each env snapshot against the first one, ignoring noisy variables (`PWD`,
`OLDPWD`, `_`, `SHLVL`, prompt-theme internals). Values whose names look secret (`*SECRET*`,
`*TOKEN*`, `*PASSWORD*`, `*KEY*` except `AWS_PROFILE`/`AWS_REGION`) are masked in the panel.
The main process converts WSL paths (`/mnt/c/...` → `C:\...`, others →
`\\wsl.localhost\<distro>\...`) for downloads.

## Consequences
- A few KB of escape-sequence traffic per prompt (the full env, base64). Negligible.
- Users with heavily customised `PROMPT_COMMAND`/`precmd` still work. We append, never
  replace.
- The OSC number 7337 is private to this app. Other terminals ignore unknown OSCs, so nested
  sessions (ssh) simply don't report.
