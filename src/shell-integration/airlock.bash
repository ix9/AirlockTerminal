# Airlock Terminal shell integration (see docs/adr/0002-shell-integration.md).
# Used as bash --init-file, which replaces the normal startup files, so load them the way a
# login shell would (WSL and macOS terminals start login shells).
if [ -r /etc/profile ]; then . /etc/profile; fi
if [ -r ~/.bash_profile ]; then . ~/.bash_profile
elif [ -r ~/.bash_login ]; then . ~/.bash_login
elif [ -r ~/.profile ]; then . ~/.profile
elif [ -r ~/.bashrc ]; then . ~/.bashrc
fi

# Every prompt reports the current directory and environment via a private OSC sequence:
#   ESC ] 7337 ; airlock ; base64(cwd) ; base64(NUL-separated KEY=VALUE) BEL
# It also marks command blocks (ADR 0007) with standard OSC 133 sequences: D;<exit> when the last
# command has finished, then A where the prompt starts.
__airlock_report() {
  local status=$? n
  __airlock_waiting= # bash < 4.4: no command was typed (see __airlock_debug below)
  printf '\033]133;D;%s\007' "$status"
  printf '\033]7337;airlock;%s;%s\007' \
    "$(printf '%s' "$PWD" | base64 | tr -d '\n')" \
    "$(for n in $(compgen -e); do printf '%s=%s\0' "$n" "${!n}"; done | base64 | tr -d '\n')"
  __airlock_lasthist=$(HISTTIMEFORMAT= builtin history 1)
  printf '\033]133;A\007'
  return $status
}

# Run first, and pass the exit status through, so prompt themes still see the real $?.
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__airlock_report "${PROMPT_COMMAND[@]}")
else
  PROMPT_COMMAND="__airlock_report${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi

# Just before a command runs: its command line (ESC ] 7337 ; cmd ; base64(command) BEL), then C
# where its output starts. The command comes from history, so a command that history leaves out
# (HISTCONTROL=ignorespace, say) is sent without its command line, and the app reads it off the
# screen instead.
__airlock_preexec() {
  local h
  h=$(HISTTIMEFORMAT= builtin history 1)
  if [[ -n "$h" && "$h" != "$__airlock_lasthist" ]]; then
    printf '\033]7337;cmd;%s\007' "$(printf '%s' "$h" | sed -E '1s/^ *[0-9]+\*? *//' | base64 | tr -d '\n')"
  fi
  printf '\033]133;C\007'
}
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  PS0="${PS0}"'$(__airlock_preexec)'
elif [[ -z "$(trap -p DEBUG)" ]]; then
  # No PS0 before bash 4.4 (macOS ships 3.2), so use the DEBUG trap, which runs before every
  # command. The first one after the prompt has been drawn is the command typed there. Left alone
  # if something else (bash-preexec, say) already uses the trap: the app then works the block out
  # from where Enter was pressed.
  __airlock_ready() { __airlock_waiting=1; }
  __airlock_debug() {
    [[ -n "$__airlock_waiting" && "$BASH_COMMAND" != __airlock_report* ]] || return 0
    __airlock_waiting=
    __airlock_preexec
  }
  trap '__airlock_debug' DEBUG
  PROMPT_COMMAND="${PROMPT_COMMAND}; __airlock_ready"
fi

# Over SSH (ADR 0008) this file is a temporary copy, sent by the app for this session only.
__airlock_cleanup() {
  case "$AIRLOCK_CLEANUP" in
    /tmp/*|/var/folders/*|"${TMPDIR:-/tmp}"/*) rm -rf -- "$AIRLOCK_CLEANUP" ;;
  esac
  unset AIRLOCK_CLEANUP
}
[ -n "$AIRLOCK_CLEANUP" ] && __airlock_cleanup
