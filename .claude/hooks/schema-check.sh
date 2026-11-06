#!/usr/bin/env bash
# Stop hook: when the data model or access rules changed on this branch without a
# migration or a test change, ask Claude once (per change) to add them or say why not.
input=$(cat)
[[ "$(jq -r '.stop_hook_active // false' <<<"$input")" == "true" ]] && exit 0
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"; cd "$root" 2>/dev/null || exit 0
base=$(git merge-base HEAD origin/main 2>/dev/null) || exit 0
changed=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
grep -Eq '^src/(collections|access)/' <<<"$changed" || exit 0
stamp=$(git diff "$base" -- src/collections src/access 2>/dev/null | shasum | cut -c1-16)
mark="$(git rev-parse --git-dir)/claude-schema-check"
[[ -f "$mark" && "$(cat "$mark")" == "$stamp" ]] && exit 0
echo "$stamp" >"$mark"
missing=()
grep -Eq '^src/collections/' <<<"$changed" && ! grep -Eq '^src/migrations/' <<<"$changed" && missing+=("migration (pnpm migrate:create)")
! grep -Eq '^tests/' <<<"$changed" && missing+=("test run as each role (tests/access)")
[[ ${#missing[@]} -eq 0 ]] && exit 0
list="${missing[0]}"; [[ ${#missing[@]} -gt 1 ]] && list="$list and no ${missing[1]}"
reason="The data model or access rules changed on this branch, but there is no $list. Add it, or tell the user why it is not needed (for example, only access code changed, no columns)."
jq -n --arg r "$reason" '{decision:"block", reason:$r}'
exit 0
