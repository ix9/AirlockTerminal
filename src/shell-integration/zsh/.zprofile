ZDOTDIR="$AIRLOCK_USER_ZDOTDIR"
[[ -r "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
AIRLOCK_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__airlock_dir"
