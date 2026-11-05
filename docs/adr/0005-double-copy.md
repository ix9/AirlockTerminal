# ADR 0005: Double-copy runs a command

**Status:** Accepted
**Date:** 2026-11-05

## Context
Reviewing in the airlock before running is the app's main safeguard, but working through a trusted
runsheet or a chat means pressing Run many times. The user wants a faster path: copy the same text
twice quickly and it runs.

This changes what the claude.ai page can do. Page scripts can call the clipboard and the copy hook
(ADR 0001), and until now the worst outcome was text in the airlock. If copies alone could trigger
a run, a script could run commands in the user's terminal.

## Decision
Copying the same text twice within 1.5 seconds runs it. Both copies must be real user actions:

- **The main process confirms each action.** `before-input-event` and `before-mouse-event` report
  real key presses and mouse presses, and a page can't produce or suppress them. A copy counts only
  if one happened within the previous second.
- **Each copy needs its own press.** A held key adds no press, and one click that writes to the
  clipboard twice has only one.
- **Only claude.ai's top frame counts** for chat copies. Copies from subframes still reach the
  airlock, but can't run anything.
- **The text must match exactly.**
- **A third copy starts over,** so repeated presses don't run a command repeatedly.
- **`To airlock` never runs anything,** even when double-clicked.
- **It can be turned off** in Settings. It's on by default, because the user asked for it.

The status bar shows when the first copy landed and what ran. Runs are recorded in History. Focus
stays where it was, because on Windows and Linux another Ctrl+C in the terminal would interrupt the
command that just started.

### The Web tab
The Web tab loads any site, so pages there get less. A hostile page could write a command to the
clipboard on every click, so double-clicking a word would run it if double-copy worked everywhere.

- **Auto-run is off per site** until the user turns it on with the toolbar button, which only ever
  applies to the site really showing. It needs HTTPS, so a network attacker can't inject a page, and
  it's granted to one exact origin. Settings lists these sites and can remove them.
- **Copies need a real press** even to reach the airlock, or a page could silently replace a
  command waiting there. Only the visible tab's top frame counts.
- **Containment:** a separate session from the chat, sandboxed, with no camera, microphone, location
  or notification permissions. Only http and https can load. Downloads go to the Downloads folder,
  not the terminal's directory.

## Consequences
- In the second after a real click on a Web tab page, that page can still replace the airlock text.
  Check the airlock before pressing Run, especially after using an untrusted site.
- Sites with Auto-run on are fully trusted: a page there controls what it copies, so a double-copy
  runs whatever it wrote. Markdown runsheets load remote images, which tells those servers your
  IP address and when the runsheet was opened.
- A double-copied command runs without review, whatever it contains, in whatever is in the active
  terminal, such as a text editor or an SSH session.
- A compromised claude.ai page could still swap the text it writes when the user really clicks
  twice. This needs the user to act and the first-party page to be compromised, so it's accepted;
  turning the feature off removes it.
