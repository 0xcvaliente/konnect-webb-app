#!/usr/bin/env bash
# PreToolUse guard for Bash. Blocks: reading secrets, pushing or committing to main,
# force-pushing, and wiping the database. Exit 2 = block; stderr goes back to Claude.
set -uo pipefail
input=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
cwd=$(jq -r '.cwd // ""' <<<"$input")
[[ -n "$cwd" && -d "$cwd" ]] && cd "$cwd"
block() { echo "Blocked by .claude/hooks/guard-bash.sh: $1" >&2; exit 2; }

# 1. Secrets: .env files (not .env.example) and the credentials folder.
if grep -Eq '(^|[^A-Za-z0-9_.-])\.env(\.(local|production|development|test|prod|dev))?([^A-Za-z0-9_.-]|$)' <<<"$cmd" \
  || grep -Eq '(^|[^A-Za-z0-9_])credentials/|client_secret[^ ]*\.json' <<<"$cmd"; then
  block "this command touches .env or credentials. Secrets stay out of the session; ask the user to run it."
fi

# 2. Git: no force-push, no push to main/master, no commit while on main.
if grep -Eq '(^|[;&|[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push' <<<"$cmd"; then
  grep -Eq -- '(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$)|[[:space:]]\+)' <<<"$cmd" && block "force-push is not allowed."
  grep -Eq '(^|[[:space:]:/])(main|master)([[:space:]]|$)' <<<"$cmd" && block "pushing to main is not allowed. Push the feat/ branch and open a pull request."
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  [[ "$branch" == "main" || "$branch" == "master" ]] && block "you are on $branch. Create a feat/<name> branch first."
fi
if grep -Eq '(^|[;&|[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+commit' <<<"$cmd"; then
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  [[ "$branch" == "main" || "$branch" == "master" ]] && block "you are on $branch. Create a feat/<name> branch before committing."
fi

# 3. Database: no wiping data or volumes.
if grep -Eq 'migrate:(fresh|reset)|docker[[:space:]-]+compose.*[[:space:]]down.*[[:space:]](-v|--volumes)|docker[[:space:]]+volume[[:space:]]+(rm|prune)|dropdb' <<<"$cmd"; then
  block "this would delete database data. Ask the user to run it if it is really needed."
fi
exit 0
