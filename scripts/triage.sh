#!/usr/bin/env bash
# Issue triage, run by the webhook-triggered `triage` job in the checkout of
# the project it triages. The agent only reads and edits the checkout. Every
# GitLab write happens here, with TRIAGE_TOKEN, which the agent never holds.
set -Eeuo pipefail

main() {
: "${TRIAGE_TOKEN:?}" "${TRIAGE_API_KEY:?}" "${TRIAGE_MODEL:?}"

bot_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
project=$CI_PROJECT_ID
server=${CI_SERVER_URL:-https://gitlab.com}
protected=${TRIAGE_PROTECTED_PATHS:-'^(\.gitlab-ci\.yml$|\.gitlab/|\.github/|\.agents/|\.claude/|AGENTS\.md$|CLAUDE\.md$|\.mcp\.json$|\.envrc$|flake\.(nix|lock)$|renovate\.json$|\.pre-commit-config\.yaml$)|(^|/)\.git(attributes|ignore|modules)$'}
states="needs-triage not-actionable needs-reproduction unable-to-reproduce unable-to-fix needs-approval approved fix-pending failed"

api() { (cd "$work" && GITLAB_HOST=$server GITLAB_TOKEN=$TRIAGE_TOKEN glab api "$@"); }

iid=$(jq -r 'if .object_kind == "note" then .issue.iid else .object_attributes.iid end // empty' "$TRIGGER_PAYLOAD")
if ! [[ $iid =~ ^[0-9]+$ ]]; then
	echo "Not an issue event, nothing to do"
	exit 0
fi
branch="triage/issue-$iid"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
api --paginate "projects/$project/members/all?per_page=100" | jq -s 'add | map(select(.access_level >= 20 and .state == "active") | {username, access_level})' >"$work/access.json"
jq 'map(.username)' "$work/access.json" >"$work/members.json"

bot=$(api user | jq -r .username)
api "projects/$project/issues/$iid" >"$work/issue.json"
action=$(jq -r --arg bot "$bot" --slurpfile issue "$work/issue.json" -f "$bot_dir/scripts/triage-route.jq" "$TRIGGER_PAYLOAD")
echo "Issue #$iid: $action"
[ "$action" != skip ] || exit 0

sender=$(jq -r .user.username "$TRIGGER_PAYLOAD")
case $(jq -r '"\(.object_kind):\(.object_attributes.action)"' "$TRIGGER_PAYLOAD"):$action in
note:*:*) actor=$(api "projects/$project/issues/$iid/notes/$(jq -r '.object_attributes.id | numbers // 0' "$TRIGGER_PAYLOAD")" | jq -r '.author.username // empty') ;;
issue:open:*) actor=$(jq -r '.author.username // empty' "$work/issue.json") ;;
issue:reopen:*) actor=$(api --paginate "projects/$project/issues/$iid/resource_state_events?per_page=100" | jq -rs 'add | map(select(.state == "reopened")) | last | .user.username // empty') ;;
issue:update:*)
	label=triage::needs-triage
	[ "$action" != implement ] || label=triage::approved
	actor=$(api --paginate "projects/$project/issues/$iid/resource_label_events?per_page=100" | jq -rs --arg label "$label" 'add | map(select(.action == "add" and .label.name == $label)) | last | .user.username // empty')
	;;
*) actor=$sender ;;
esac
if [ "$actor" != "$sender" ]; then
	echo "The webhook's sender doesn't match GitLab's records, nothing to do"
	exit 0
fi
if ! jq -e --arg sender "$sender" 'any(.[]; . == $sender) and ($sender | test("^(project|group)_[0-9]+_bot") | not)' "$work/members.json" >/dev/null; then
	echo "Triggered by a bot or someone below Reporter, nothing to do"
	exit 0
fi

close_mrs() {
	local mrs mr
	mrs=$(api "projects/$project/merge_requests?state=opened&source_branch=$branch" | jq '.[] | select(.source_project_id == .target_project_id) | .iid')
	for mr in $mrs; do
		api -X PUT "projects/$project/merge_requests/$mr" -f state_event=close >/dev/null
		echo "$mr"
	done
}
retire_branch() {
	close_mrs
	api -X DELETE "projects/$project/repository/branches/${branch//\//%2F}" >/dev/null 2>&1 || true
}

# Scoped labels keep one triage:: label per issue only on GitLab Premium, so
# remove the others explicitly. GitLab creates a label the first time it is used.
set_label() {
	local label=${1// /-} others
	others=$(printf 'triage::%s\n' $states | grep -vxF "triage::$label" | paste -sd, -)
	api -X PUT "projects/$project/issues/$iid" -f add_labels="triage::$label" -f remove_labels="$others" >/dev/null
}

case $action in
cleanup)
	retire_branch >/dev/null
	exit 0
	;;
implement)
	if ! jq -e --arg sender "$sender" 'any(.[]; .username == $sender and .access_level >= 40)' "$work/access.json" >/dev/null; then
		echo "Only a Maintainer approves a plan, back to needs approval"
		set_label "needs approval"
		exit 0
	fi
	;;
esac
note() {
	local body=$'\n'"${1//$'\r'/}"
	body=${body//$'\n'\//$'\n'\\/}
	body=$(jq -Rrs 'gsub("(?<![A-Za-z0-9_])@(?<b>[A-Za-z0-9_.])"; "@​\(.b)") | gsub("<!--"; "&lt;!--")' <<<"$body")
	api -X POST "projects/$project/issues/$iid/notes" -f body="${body#$'\n'}"$'\n\n'"<sub>Automated triage · [job]($CI_JOB_URL)</sub> <!-- triage-read: ${read_id:-0} -->${marker:-}" >/dev/null
}
fail() {
	[ "$BASHPID" = "$$" ] || exit 1
	trap - ERR
	read_id=0
	marker=" <!-- triage-failed -->"
	local n=$((${failures:-0} + 1)) retry="A new comment retries it."
	[ -n "${failures:-}" ] || retry="A new comment retries it unless the last three runs failed; adding \`triage::needs-triage\` always does."
	[ "$n" -lt 3 ] || retry="That is $n failed runs in a row, so comments no longer retry it; add \`triage::needs-triage\` or reopen the issue to try again."
	set_label failed
	note "Triage failed: $1. $retry${closed:+ The earlier proposed fix !${closed//$'\n'/, !} was closed first.}"
	exit 1
}
trap 'fail "see the job log"' ERR
api --paginate "projects/$project/issues/$iid/notes?sort=asc&per_page=100" |
	jq -s --slurpfile members "$work/members.json" --arg bot "$bot" 'add | map(select((.system or .internal | not) and (.author.username == $bot or ((.author.username | IN($members[0][])) and (.author.username | test("^(project|group)_[0-9]+_bot") | not)))))' >"$work/notes.json"
read_id=$(jq '[.[].id] | max // 0' "$work/notes.json")
if jq -e --slurpfile event "$TRIGGER_PAYLOAD" --arg bot "$bot" '$event[0] as $e | $e.object_kind == "note" and
	([.[] | select(.author.username == $bot) | [.body | capture("<!-- triage-read: (?<n>[0-9]+) -->"; "g")] | last | .n? // empty | tonumber] | max // 0) >= $e.object_attributes.id' "$work/notes.json" >/dev/null; then
	echo "A later run already read this comment, nothing to do"
	exit 0
fi

failures=$(jq --arg bot "$bot" '[.[] | select(.author.username == $bot) | .body | contains("<!-- triage-failed -->")] | reverse | index(false) // length' "$work/notes.json")
if [ "$failures" -ge 3 ] && jq -e '.object_kind == "note"' "$TRIGGER_PAYLOAD" >/dev/null && jq -e '.labels | index("triage::failed")' "$work/issue.json" >/dev/null; then
	echo "The last three runs failed, so comments no longer retry it"
	exit 0
fi

if [ "$action" = implement ]; then
	plan=$(jq -r --arg bot "$bot" '[.[] | select(.author.username == $bot and (.body | contains("<!-- triage-plan -->")))] | last | .body // empty' "$work/notes.json")
	[ -n "$plan" ] || fail "there is no plan from triage to implement"
else
	set_label "needs triage"
fi

{
	cat "$bot_dir/prompt.md"
	printf '\nThis job refuses to publish a fix that changes a path matching the extended regular expression `%s`.\n\n' "$protected"
	jq -rn --slurpfile issue "$work/issue.json" --slurpfile notes "$work/notes.json" --arg plan "${plan:-}" '
		def text: gsub("<\\s*/?\\s*(?<t>issue|approved-plan)\\s*>"; "[\(.t)]"; "i");
		$issue[0] as $i
		| "<issue>\n# \($i.title | text)\n\nOpened by @\($i.author.username)\n\n\($i.description // "" | text)\n",
		  ($notes[0][] | "\n## Comment by @\(.author.username)\n\n\(.body | text)\n"),
		  "</issue>",
		  if $plan != "" then "\n<approved-plan>\n\($plan | text)\n</approved-plan>" else empty end'
} >"$work/input.md"

# The agent has a shell, so it runs as its own user: it can't read this
# script's environment, where TRIAGE_TOKEN is, or write .git.
agent=() agent_home=$HOME
if [ "$(id -u)" = 0 ]; then
	adduser -D triage
	agent=(su-exec triage) agent_home=/home/triage
	[ ! -d "${CI_PROJECT_DIR:-}.tmp" ] || chmod 700 "$CI_PROJECT_DIR.tmp"
	mkdir -p /nix && chown -R triage: /nix
	chown -R triage: . && chown -R root: .git
	git config --system --add safe.directory "$PWD"
elif [ -n "${GITLAB_CI:-}" ]; then
	fail "the job has to run as root to start the agent as its own user"
fi

git remote set-url origin "$server/$CI_PROJECT_PATH.git"
git config --local --name-only --get-regexp '^url\.' | while read -r name; do
	git config --local --remove-section "${name%.*}" 2>/dev/null || true
done || true
if [ -n "${CI_JOB_TOKEN:-}" ] && grep -qF -- "$CI_JOB_TOKEN" .git/config; then fail "the job token is still in .git/config"; fi
git_state() { { git config --local --list; git rev-parse HEAD; git for-each-ref; cat .git/info/attributes .git/info/exclude .git/info/sparse-checkout .git/commondir .git/objects/info/alternates 2>/dev/null || true; find .git/hooks -type f -exec sha256sum {} + 2>/dev/null || true; } | sha256sum; }
before=$(git_state)

status=0
"${agent[@]}" env -i PATH="$PATH" HOME="$agent_home" LANG=C.UTF-8 \
	TRIAGE_API_KEY="$TRIAGE_API_KEY" TRIAGE_MODEL="$TRIAGE_MODEL" TRIAGE_THINKING="${TRIAGE_THINKING:-}" CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}" \
	NIX_CONFIG=$'experimental-features = nix-command flakes\nbuild-users-group =\nsandbox = false' \
	timeout -k 60 1320 node "$bot_dir/dist/agent.mjs" <"$work/input.md" >"$work/result.json" || status=$?
[ ${#agent[@]} = 0 ] || "${agent[@]}" kill -KILL -1 2>/dev/null || true
[ "$status" = 0 ] || fail "the agent exited with an error or ran out of time"

result=$(jq -ce 'select(type == "object" and (.comment | type) == "string")' "$work/result.json") || fail "the agent returned no result"
outcome=$(jq -r .outcome <<<"$result")
case $action:$outcome in
implement:fixed | "implement:unable to fix") ;;
implement:*) fail "the agent neither implemented the approved plan nor said why it couldn't" ;;
*:"not actionable" | *:"needs reproduction" | *:"unable to reproduce" | *:"unable to fix" | *:"needs approval" | *:fixed) ;;
*) fail "the agent returned an unknown outcome" ;;
esac
comment=$(jq -r .comment <<<"$result")
message=$(jq -r '(.commit_message // "") | (split("\n")[0] // "") | gsub("https?://\\S+"; "") | gsub("\\[(ci[ _-]skip|skip[ _-]ci)\\]"; ""; "i") | gsub("[\\[\\]#@]"; "") | gsub("^\\s+|\\s+$"; "") | .[0:200]' <<<"$result")
[[ $message =~ ^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^\)]+\))?!?:\ .+ ]] || message=""
if [ "$(git_state)" != "$before" ]; then fail "the agent changed the repository's .git state"; fi
rm -f .git/CHERRY_PICK_HEAD .git/MERGE_HEAD .git/MERGE_MSG .git/REVERT_HEAD
git add -A

for token in "$TRIAGE_API_KEY" "$TRIAGE_TOKEN" "${CI_JOB_TOKEN:-}"; do
	if [ -n "$token" ] && grep -qF -- "$token" <<<"$result$(git diff --no-ext-diff --cached --text)"; then
		fail "the agent's output contained a token, so nothing was published"
	fi
done

refused=""
if [ "$outcome" = fixed ]; then
	outside=$(git -c core.quotePath=false diff --cached --name-only --no-renames | grep -E -- "$protected" || true)
	hidden=$(git ls-files -o -i --exclude-standard | grep -E '(^|/)\.git(attributes|ignore)$' || true)
	binary=$(git diff --cached --numstat --no-renames | awk '$1 == "-"')
	raw=$(git diff --cached --raw --no-renames)
	if git diff --cached --quiet; then
		refused="the agent reported a fix but changed nothing"
	elif [ -n "$outside" ]; then
		refused="it touches $(paste -sd, - <<<"$outside"), which triage may not change"
	elif [ -n "$hidden" ]; then
		refused="it hides $(paste -sd, - <<<"$hidden") from git"
	elif [ -n "$binary" ]; then
		refused="it changes a binary file"
	elif grep -qE '^:[0-7]+ 160000 ' <<<"$raw"; then
		refused="it adds an embedded repository"
	fi
fi
if [ "$outcome" = fixed ] && [ -z "$refused" ]; then
	git -c user.name="$bot" -c user.email="$bot@noreply.${server#*://}" \
		commit -q --no-verify -m "${message:-fix: resolve #$iid}" -m "Closes #$iid"
	closed=$(close_mrs)
	git push -qf "${server%%://*}://oauth2:$TRIAGE_TOKEN@${server#*://}/$CI_PROJECT_PATH.git" "HEAD:refs/heads/$branch" -o ci.skip
	api -X POST "projects/$project/merge_requests" -f source_branch="$branch" -f target_branch="$CI_DEFAULT_BRANCH" \
		-f title="$(git log -1 --format=%s)" -f description="Closes #$iid" -f remove_source_branch=true >/dev/null
	comment+=$'\n\n'"Proposed fix: branch \`$branch\`, in a merge request that closes this issue. A maintainer runs its pipeline after reading the diff."
	outcome="fix pending"
else
	if [ -n "$refused" ]; then
		outcome="unable to fix"
		comment+=$'\n\n'"The proposed fix was not pushed: $refused."
	fi
	closed=$(retire_branch)
	if [ "$outcome" = "needs approval" ]; then
		comment+=$'\n\n'"A Maintainer swaps \`triage::needs-approval\` for \`triage::approved\` to have this plan implemented; a comment revises it."
		marker=" <!-- triage-plan -->"
	elif [ "$outcome" != "not actionable" ]; then
		comment+=$'\n\n'"Reply in a comment to run triage again."
	fi
fi
for mr in $closed; do
	comment+=$'\n\n'"The earlier proposed fix, !$mr, is closed."
done

trap - ERR
set_label "$outcome"
note "$comment"
}
main "$@"; exit
