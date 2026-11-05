ZDOTDIR="$AIRLOCK_USER_ZDOTDIR"
[[ -r "$ZDOTDIR/.zlogin" ]] && source "$ZDOTDIR/.zlogin"
# Done: leave the shell with the user's own ZDOTDIR.
unset AIRLOCK_USER_ZDOTDIR __airlock_dir
