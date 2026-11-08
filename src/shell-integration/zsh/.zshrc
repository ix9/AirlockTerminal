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

# Command blocks (ADR 0007), as standard OSC 133 marks:
#   D;<exit>  the last command finished     A  a prompt starts     C  a command's output starts
# plus the command line itself, before it runs:  ESC ] 7337 ; cmd ; base64(command) BEL
__airlock_precmd() {
  local ret=$?
  printf '\033]133;D;%s\007' $ret
  __airlock_report
  printf '\033]133;A\007'
  return $ret # so prompt themes' hooks after this one still see the real $?
}
__airlock_preexec() {
  printf '\033]7337;cmd;%s\007\033]133;C\007' "$(print -rn -- "$1" | base64 | tr -d '\n')"
}
autoload -Uz add-zsh-hook
# First, so it reads the command's exit status before any other hook changes it.
precmd_functions=(__airlock_precmd ${precmd_functions[@]})
add-zsh-hook preexec __airlock_preexec
