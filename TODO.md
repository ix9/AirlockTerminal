# TODO

## Next session
- [ ] **Multiple terminals in tabs.** Each tab gets its own shell, env strip and cwd. Downloads
  and the AWS picker follow the active tab.
- [ ] **A few themes.** At least VS Code Dark Modern (current), a light theme and a
  high-contrast theme, covering the UI and the xterm.js colours.
- [ ] **SSH terminal?** Decide between an entry in the shell picker (`ssh host`, using
  `~/.ssh/config` hosts) and a built-in SSH client. Shell integration won't report over SSH
  unless the remote side runs the hook.
- [ ] **`aws sso login` doesn't complete.** The browser's OAuth callback hit `127.0.0.1` and
  found no server. Find out which shell it ran in and whether the CLI's local listener was
  reachable from where the browser opened the link (WSL vs Windows localhost). Workaround
  to try: `aws sso login --use-device-code`.
- [ ] **Where do we store snippets and history?** Currently `snippets.json` and
  `history.jsonl` in the app's user data folder (`%APPDATA%\airlock-terminal` on Windows,
  `~/Library/Application Support/airlock-terminal` on macOS, `~/.config/airlock-terminal` on
  Linux). Decide whether to make the location configurable, show it in the UI, or sync it
  (for example a git repo or OneDrive folder).
- [ ] **Save terminal scrollback history?** For example with the xterm.js serialize addon, per
  tab, restored on restart. Consider size limits and secrets that may appear in output.

## Also pending
- [ ] Remember window size, divider positions, terminal font size and last shell.
- [ ] Package installers (Windows, macOS; Linux AppImage) with electron-builder. Keep
  `src/shell-integration` outside the asar archive so shells can read it. Move `electron` to
  devDependencies.
- [ ] Find out why `npm install` didn't download the Electron binary on first install.
