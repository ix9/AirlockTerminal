ZDOTDIR="$AIRLOCK_USER_ZDOTDIR"
[[ -r "$ZDOTDIR/.zlogin" ]] && source "$ZDOTDIR/.zlogin"
# Done: leave the shell with the user's own ZDOTDIR.
unset AIRLOCK_USER_ZDOTDIR __airlock_dir
# Over SSH (ADR 0008) these files are a temporary copy, sent by the app for this session only.
case "$AIRLOCK_CLEANUP" in
  /tmp/*|/var/folders/*|"${TMPDIR:-/tmp}"/*) rm -rf -- "$AIRLOCK_CLEANUP" ;;
esac
unset AIRLOCK_CLEANUP
