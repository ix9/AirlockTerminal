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
__airlock_report() {
  local status=$? n
  printf '\033]7337;airlock;%s;%s\007' \
    "$(printf '%s' "$PWD" | base64 | tr -d '\n')" \
    "$(for n in $(compgen -e); do printf '%s=%s\0' "$n" "${!n}"; done | base64 | tr -d '\n')"
  return $status
}

# Run first, and pass the exit status through, so prompt themes still see the real $?.
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__airlock_report "${PROMPT_COMMAND[@]}")
else
  PROMPT_COMMAND="__airlock_report${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
