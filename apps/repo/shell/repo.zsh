typeset -g DAILYLIFE_REPO_ROOT="${${(%):-%N}:A:h:h}"
typeset -g DAILYLIFE_REPO_ENTRY="$DAILYLIFE_REPO_ROOT/src/index.js"

unalias repo 2>/dev/null

repo() {
  if [ "$1" = "list" ] || [ "$1" = "help" ] || [ "$1" = "shell-init" ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    node "$DAILYLIFE_REPO_ENTRY" "$@"
    return $?
  fi

  for arg in "$@"; do
    if [ "$arg" = "--json" ] || [ "$arg" = "--plain" ]; then
      node "$DAILYLIFE_REPO_ENTRY" "$@"
      return $?
    fi
  done

  local tmp_file
  local target
  local exit_code

  tmp_file="$(mktemp -t repo-select.XXXXXX)" || return 1
  REPO_SELECTED_PATH_FILE="$tmp_file" node "$DAILYLIFE_REPO_ENTRY" "$@"
  exit_code=$?

  if [ "$exit_code" -ne 0 ]; then
    rm -f "$tmp_file"
    return "$exit_code"
  fi

  target="$(cat "$tmp_file")"
  rm -f "$tmp_file"

  if [ -n "$target" ] && [ -d "$target" ]; then
    cd "$target"
  elif [ -n "$target" ]; then
    printf '%s\n' "$target"
  fi
}
