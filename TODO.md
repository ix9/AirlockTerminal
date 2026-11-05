# TODO

## Needs a decision or a test
- [ ] **`aws sso login` doesn't complete in WSL on Windows.** The browser's OAuth callback hit
  `127.0.0.1` and found no server. Next step: run it in plain Windows Terminal with the same
  distro. If it fails there too, it's a WSL networking or AWS issue, so document
  `aws sso login --use-device-code` as the fix. If it only fails in Airlock, look at how the app
  starts WSL and opens links.

## Deferred
- [ ] **SSH in the shell picker.** If this comes back: list hosts from `~/.ssh/config` plus free
  entry, and run the system `ssh` so config, agents and jump hosts keep working. Avoid a built-in
  client. The config may use `Include`, so resolve it rather than scanning for `Host` lines. Hide
  the AWS picker in those tabs, and expect Save and downloads to fall back to Downloads, since
  remote shells don't report their directory.
- [ ] **Signed installers,** if the app is ever published for other people. Needs a paid Apple
  Developer account and a Windows certificate.
