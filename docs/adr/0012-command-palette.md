# ADR 0012: Command palette with Ask AI

**Status:** Accepted
**Date:** 2026-11-22

## Context
Commands come from many places: what's been run in this terminal, the airlock's history, local,
Team and Personal snippets, and Runsheet files. Finding one meant knowing which list it was in.
Often the command isn't anywhere yet, and you have to work it out or ask the chat. This came from
the Composer mockup (ADR 0011), which was otherwise kept for later.

## Decision
**⌘K** on macOS (**Ctrl+Shift+K** elsewhere, since the shell owns Ctrl+K), or the toolbar's search
button, opens a palette over the terminal. It's placed clear of the prompt: above it, ending two
lines short, or below it when the prompt is near the top. The terminal is unchanged underneath.

**Ask AI is always the first row.** Under it, the same words search:
- **This tab:** the commands run in this terminal, from the command line the shell integration
  sends (ADR 0007) or, on bash 3.2, what was typed. Each one has when and where it ran. Every tab
  keeps its own list of up to 500, saved with the tab when Settings saves terminal output.
- **Airlock history:** everything run from the airlock.
- **Snippets:** local, and every Team and Personal repo.
- **Runsheet:** lines from every file in the Runsheet folder. In Markdown, only lines inside code
  blocks; in scripts, lines that aren't comments.

A short query must match every word; a longer, chattier one at least half its meaningful words,
best matches first.

**Ask AI** sends the question to a local model through an OpenAI-style API: LM Studio, Ollama,
llama.cpp. The default server is `http://localhost:1235/v1`, changeable in Settings, along with
the model (blank picks the first chat model, preferring an instruct one). The model gets the
question, the shell, the OS and the folder. It never gets what's on screen. It's asked for JSON,
and the reply is read leniently: the first complete object, with stray escapes kept. Small models
add text after the answer, and write things like `\;`.

The suggestion is an editable command, with a short explanation and up to two alternatives (⇥).
- **↵** runs it.
- **⌘↵** puts it in the airlock instead.
- **⌥↵** takes the question to the chat.

The same keys work on any search result. (Running was first on ⌘↵ with the airlock on ↵; the user
chose to swap them, so the palette is the quick way to run things and the airlock the careful
one.)

**Risk is decided by the app, not the model.** Every command, suggested or edited, is checked
against patterns: `rm`, `-delete`, `dd`, `> file`, `Remove-Item`, `DROP TABLE`, `git reset --hard`,
`kubectl delete` and so on count as "deletes or overwrites"; `chmod`, `mv`, `sudo`,
`systemctl restart` and so on as "changes". The result can only raise the model's own label,
never lower it. Anything that deletes or overwrites can't run from the palette: ↵ sends it to the
airlock instead, whether it came from AI or from history.

## Consequences
- With no model server running, Ask AI says so and the search still works.
- A small local model's suggestions can be wrong, and ↵ runs them. The command is in an editable
  field with its risk label before anything runs, and ⌘↵ sends it to the airlock for a closer look.
- The risk patterns are a safety net, not a guarantee. A command they don't recognise is
  labelled by the model's own judgement.
- History from before a tab was opened (the shell's own history file) isn't searched. That file
  is shared by every tab, so if it's added it should be its own group.
