#!/usr/bin/env bash
# PostToolUse for Edit/Write: run Prettier on the changed file so CI's format check passes.
input=$(cat)
f=$(jq -r '.tool_input.file_path // ""' <<<"$input")
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
prettier="$root/node_modules/.bin/prettier"
[[ -z "$f" || ! -f "$f" || ! -x "$prettier" ]] && exit 0
case "$f" in "$root"/*) ;; *) exit 0 ;; esac
case "$f" in *.ts|*.tsx|*.js|*.mjs|*.cjs|*.json|*.md|*.css|*.yml|*.yaml)
  (cd "$root" && "$prettier" --write --ignore-unknown --log-level warn "$f") >/dev/null 2>&1 ;;
esac
exit 0
