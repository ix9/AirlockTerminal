# ADR 0008: Remote sessions as terminal tabs

**Status:** Accepted
**Date:** 2026-11-08

## Context
People run commands on servers as often as on their own machine: Windows servers over PowerShell
remoting, and Linux machines, network gear and Macs over SSH. The airlock, Copy last, Send to Claude
and find should work there too, and the app should make it obvious where Run will go, because the
same command can mean very different things on a production server.

## Decision
**A remote is a terminal tab.** It runs a command on this machine that connects, so everything
that works on a tab works on it, and nothing new sits between the user and the server:

- **SSH:** the system `ssh`, so `~/.ssh/config`, keys, `ssh-agent`, jump hosts and known hosts all
  apply as they do in any terminal. The app sends its shell integration (ADR 0002) with the
  connection: a POSIX `sh` script, in base64 so no shell on the way can change it, writes the
  integration to a temporary folder and starts the user's login shell with it. The integration
  deletes that folder once it's loaded. Nothing is installed on the server. bash and zsh get the
  integration; other shells start plain.
- **PowerShell (WinRM)** and **PowerShell over SSH:** a local PowerShell runs `New-PSSession`, loads
  the integration into the session with `Invoke-Command -FilePath`, and enters it with
  `Enter-PSSession`. In a session the integration notices `$PSSenderInfo` and returns its marks
  at the front of the prompt text, since the server's console isn't ours. The end-of-command mark
  is made at the start of the line, so the `[server]: ` prefix PowerShell writes isn't taken as
  output. PSReadLine isn't used in a session, so commands are found from where Enter was pressed
  (ADR 0007's fallback).
- **A tab is only ever its remote.** If connecting fails, or the session ends (`exit`), the tab's
  local shell ends too, and the tab shows Reconnect. It's never left at a local prompt while
  labelled as a server.

**Where Run goes is always visible.** Each remote can be tagged PROD, TEST or DEV. The tab shows the
tag, a PROD tab gets a red strip, and the airlock says "Runs on web-01 · PROD". Every Run in a PROD
tab asks first, whatever the command came from (airlock, snippet, runsheet), and double-copy
auto-run (ADR 0005) is off there.

**Sessions that survive.** WinRM: Disconnect leaves the session running on the server
(`Disconnect-PSSession`), and connecting again picks it up (`Get-PSSession` and
`Connect-PSSession`), even after the app has closed. The tab's shell is inside the session, so
Disconnect leaves a file for the tab's local prompt to find on the way out. SSH: an option to
connect through `tmux new-session -A`. tmux draws the screen itself, so inside it the app's command
blocks and the folder report don't work; the form says so.

**Where remotes come from:**
- A `remotes/` folder in each snippet repo (ADR 0006), next to `snippets/`, one Markdown file per
  server, synced and saved exactly like snippets. The Team repo gives a team the same servers; a
  Personal repo follows one person between machines. The file is a heading and a list:

  ```markdown
  # app-01

  - Address: app-01.example.com
  - Connect with: SSH
  - User: deploy
  - Environment: PROD

  Notes for whoever connects.
  ```
- `remotes.json` in the app's data folder, for servers kept on this machine only.
- The hosts in `~/.ssh/config` and the files it includes, read only.

**Secrets are never in any of those.** SSH keys stay with ssh (and 1Password's SSH agent, if it's
running: SSH tabs are pointed at it, unless `~/.ssh/config` already is). A WinRM sign-in is one of:
- Windows sign-in (Kerberos), with no secret at all.
- **A 1Password reference** (`op://vault/item/password`), which names a password without being one,
  so it can go in a Team repo; who can use it is decided by 1Password vault access. The tab's own
  PowerShell runs `op read` (Touch ID) straight into a `SecureString`, so the password never passes
  through the app, the screen, scrollback or history.
- A password saved on this machine, encrypted with Electron `safeStorage` (the OS keychain's key) in
  `remote-passwords.json`. The app decrypts it just before connecting and passes it to the tab's
  PowerShell in an environment variable that's removed at once.
- Ask each time (`Get-Credential` in the tab).

**New servers' keys.** Test, file copies and other background ssh can't answer ssh's "continue
connecting?" question, so by default every ssh the app runs uses `StrictHostKeyChecking=accept-new`
(PowerShell over SSH: `New-PSSession -Options`, PowerShell 7.3+). A new server's key is saved to
`~/.ssh/known_hosts` the first time; a key that has changed is still refused, with the
`ssh-keygen -R` line to clear it if the server was rebuilt. It can be turned off in Settings.

**Every field is checked.** A remote's fields end up in command lines, and anyone who can push to a
Team repo can change its files. The main process checks each field against a strict pattern when it
reads a file and when it saves one (no address or user starting with `-`, no quotes, `$` or
backticks in paths, and so on), quotes everything it builds, and only ever connects to a remote
from its own list: the UI sends an id. A file that fails the checks is listed with the reason and
can't be connected to.

**Files.** Send file and Get file copy to and from the folder the tab is in, with `scp` for SSH
and `Copy-Item -ToSession`/`-FromSession` for PowerShell (signed in the same way, so not for "Ask
each time"). A file downloaded from the chat, or a scratchpad saved, while a remote tab is active
goes to that folder on the server too, or to Downloads if that fails.

## Consequences
- Each person needs `ssh` (built into macOS, Linux and Windows 10+), and PowerShell for the
  PowerShell connection types. 1Password references need the 1Password CLI (`op`) with its desktop
  integration on. Keeping SSH sessions needs `tmux` on the server.
- Someone who can push to the Team repo could point a remote at a different server. The git history
  shows who changed what, and nothing connects or runs without a click.
- Remote tabs restored at startup don't reconnect by themselves, so opening the app never signs in
  to a server.
- An SSH remote expects a POSIX shell on the server; Windows servers over SSH should use
  PowerShell over SSH.
