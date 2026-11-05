ZDOTDIR="$AIRLOCK_USER_ZDOTDIR"
# macOS's /etc/zshrc has already aimed HISTFILE at this folder; point it at the user's instead.
[[ "$HISTFILE" == "$__airlock_dir"/* ]] && HISTFILE="$ZDOTDIR/${HISTFILE:t}"
[[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
AIRLOCK_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__airlock_dir"

# Every prompt reports the current directory and environment via a private OSC sequence:
#   ESC ] 7337 ; airlock ; base64(cwd) ; base64(NUL-separated KEY=VALUE) BEL
__airlock_report() {
  local k; local -a kv
  for k in ${(k)parameters[(R)*export*]}; do kv+=("$k=${(P)k}"); done
  printf '\033]7337;airlock;%s;%s\007' \
    "$(printf '%s' "$PWD" | base64 | tr -d '\n')" \
    "$(print -rn -- "${(pj:\0:)kv}" | base64 | tr -d '\n')"
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __airlock_report
