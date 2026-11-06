# ADR 0006: Snippets in shared git repos

**Status:** Accepted
**Date:** 2026-11-06

## Context
A team wants one shared library of reference commands that everyone can search, add to and edit
from the app. Snippets hold no secrets. It should not depend on one cloud provider, and nobody wants
to run a server for it.

## Options considered
- **AWS (Lambda Function URL + DynamoDB) with API keys.** In-app editing, but it's a service to
  build, deploy, secure and pay for, and it ties the feature to AWS.
- **GitHub's file API with a shared token.** No server, but every change shows the same author,
  revoking one person means rotating the token for everyone, the token belongs to whoever made
  it, and it only works with GitHub.
- **A git repo the app clones and pushes to (chosen).** Works with any git host (GitHub, Azure
  DevOps, GitLab, CodeCommit). Each person signs in with their own git credentials, so the app
  stores no token and history shows who changed what.

## Decision
- **Several repos**, such as a team's and a personal one, each set in Settings (`snippetRepos`) with
  a label, address, and optionally a commit name, email and SSH key. Addresses are never in source
  control. The app keeps a clone of each in `team-snippets/<id>/` in its user data folder and runs
  the system `git` from the main process. The single `teamRepoUrl` from before becomes the first
  repo, "Team".
- **Identity per repo.** The commit name and email are set in that clone's own git config, so the
  global one is never touched; blank means the global one applies. Signing in as a different
  account uses what git already offers: for HTTPS, the username in the address
  (`https://user@github.com/...`), which Git Credential Manager keeps separately; for SSH, the key
  file, set as that clone's `core.sshCommand`.
- **One Markdown file per snippet**, `snippets/<name-as-slug>.md`. The first heading is the name and
  the first code block is the command, so the files read well on the git host and can be edited
  there too:

  ````markdown
  # Restart IIS

  ```
  iisreset /restart
  ```
  ````

  The fence is made longer than any run of backticks in the command. Renaming a snippet keeps its
  file name, so its history stays in one place.
- **Sync:** fetch, then reset the clone to the server's branch. The clone only ever holds commits
  that were pushed straight away, so this never throws away anyone's work. It runs when the tab
  opens, every 5 minutes while it's showing, on Reload and before every change.
- **Changes:** sync, check the file still matches what the user opened, write, commit, push. If
  someone else changed or deleted it in the meantime, the app says so and keeps the user's text.
  If the push loses a race, it starts again from the server's version (up to 3 tries).
- **Search** runs in the app over the names and commands.
- **Two tabs** next to Runsheet, Team Snippets and Personal Snippets. Each repo is set to show in
  one of them (repos from before this split go in Team). A tab with several repos lists their
  snippets together, each labelled with its repo, with a filter for one repo. The airlock's button
  saves into the snippets tab that's showing, or else the one holding the repo used last. A new snippet goes to the repo picked in the
  form (the last one used to start with); an edited one stays in its repo. One repo failing to sync
  doesn't hide the others. Its blocks have Copy | Run like the Runsheet, and copying
  from it works like copying from the chat (ADR 0005). Nothing runs on its own. The airlock gets a
  green "Save to Repo" button.
- Git runs with `GIT_TERMINAL_PROMPT=0`, so it fails rather than waiting for a password nobody can
  type. Git Credential Manager and SSH keys still work.

## Consequences
- Each person needs git installed and signed in to the host, and a commit name and email, either
  global or per repo.
- Anyone who can push can change a command teammates run. Commands only reach the terminal by an
  explicit Run or a double-copy, each snippet shows who last edited it, and the git history can be
  used to see or undo a change. Branch protection on the host is optional.
- Others see a change when their app next syncs, not instantly.
- Two people saving different snippets at once never conflict. The same snippet: the second
  person is told and decides.
