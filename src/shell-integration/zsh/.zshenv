# Airlock Terminal shell integration: zsh starts with ZDOTDIR pointing here.
# Each file sources the user's own copy, then hands control back to this directory.
__airlock_dir="$ZDOTDIR"
ZDOTDIR="${AIRLOCK_USER_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
AIRLOCK_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__airlock_dir"
