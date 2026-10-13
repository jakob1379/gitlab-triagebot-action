#!/usr/bin/env bash
set -euo pipefail

jq_file=$(realpath "$(dirname "$0")/triage-route.jq")
failed=0

expect() {
	local want=$1 payload=$2 issue=${3:-'{"state":"opened","labels":[]}'} got
	got=$(jq -r --arg bot triagebot --slurpfile issue <(echo "$issue") -f "$jq_file" <<<"$payload")
	if [ "$got" != "$want" ]; then
		echo "FAIL: want $want, got $got for $payload with $issue"
		failed=1
	fi
}

alice='"user":{"username":"alice"}'
note="{\"object_kind\":\"note\",$alice,\"object_attributes\":{\"action\":\"create\",\"noteable_type\":\"Issue\"}}"
now() { printf '{"state":"%s","labels":["%s"]}' "$1" "$2"; }

expect triage "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"open\"}}"
expect triage "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"reopen\"}}"
expect skip "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"open\"}}" "$(now opened 'triage::unable-to-fix')"
expect triage "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"open\"}}" "$(now opened 'triage::needs-triage')"
expect triage "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"reopen\"}}" "$(now opened 'triage::not-actionable')"
expect cleanup "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"close\"}}" "$(now closed 'triage::fix-pending')"
expect skip "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"close\"}}" "$(now opened 'triage::fix-pending')"
expect skip "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"update\"}}"
expect triage "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"update\"},\"changes\":{\"labels\":{\"previous\":[{\"title\":\"bug\"}],\"current\":[{\"title\":\"bug\"},{\"title\":\"triage::needs-triage\"}]}}}" "$(now opened 'triage::needs-triage')"
expect skip "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"update\"},\"changes\":{\"labels\":{\"previous\":[{\"title\":\"bug\"}],\"current\":[{\"title\":\"bug\"},{\"title\":\"triage::needs-triage\"}]}}}" "$(now opened 'triage::needs-reproduction')"
expect skip "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"update\"},\"changes\":{\"labels\":{\"previous\":[],\"current\":[{\"title\":\"triage::needs-triage\"}]}}}" "$(now closed 'triage::needs-triage')"
expect skip '{"object_kind":"issue","user":{"username":"triagebot"},"object_attributes":{"action":"update"},"changes":{"labels":{"previous":[],"current":[{"title":"triage::needs-triage"}]}}}'
expect skip "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"update\"},\"changes\":{\"labels\":{\"previous\":[{\"title\":\"triage::needs-triage\"}],\"current\":[{\"title\":\"triage::needs-triage\"},{\"title\":\"bug\"}]}}}"
expect skip "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"update\"},\"changes\":{\"title\":{\"previous\":\"a\",\"current\":\"b\"}}}"
approve() { printf '{"object_kind":"issue",%s,"object_attributes":{"action":"update"},"changes":{"labels":{"previous":[{"title":"%s"}],"current":[{"title":"triage::approved"}]}}}' "$alice" "$1"; }
expect implement "$(approve triage::needs-approval)" "$(now opened 'triage::approved')"
expect skip "$(approve triage::unable-to-fix)" "$(now opened 'triage::approved')"
expect skip "$(approve triage::needs-approval)" "$(now opened 'triage::needs-approval')"
expect skip "$(approve triage::needs-approval)" "$(now closed 'triage::approved')"
expect skip "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"action\":\"open\"}}" "$(now opened 'triage::approved')"
expect triage "$note" "$(now opened 'triage::needs-approval')"
expect skip "$note" "$(now opened 'triage::approved')"
expect triage "$note" "$(now opened 'triage::unable-to-fix')"
expect triage "$note" "$(now opened 'triage::needs-reproduction')"
expect triage "$note" "$(now opened 'triage::unable-to-reproduce')"
expect triage "$note" "$(now opened 'triage::needs-triage')"
expect triage "$note" "$(now opened 'triage::failed')"
expect skip "$note" "$(now opened 'triage::fix-pending')"
expect skip "$note" "$(now opened 'triage::not-actionable')"
expect skip "$note" "$(now opened bug)"
expect skip "$note" "$(now closed 'triage::unable-to-fix')"
expect skip "{\"object_kind\":\"note\",$alice,\"object_attributes\":{\"action\":\"create\",\"noteable_type\":\"Issue\",\"internal\":true}}" "$(now opened 'triage::unable-to-fix')"
expect skip '{"object_kind":"note","user":{"username":"triagebot"},"object_attributes":{"action":"create","noteable_type":"Issue"}}' "$(now opened 'triage::unable-to-fix')"
expect skip "{\"object_kind\":\"note\",$alice,\"object_attributes\":{\"action\":\"create\",\"noteable_type\":\"MergeRequest\"}}"
expect skip "{\"object_kind\":\"note\",$alice,\"object_attributes\":{\"action\":\"update\",\"noteable_type\":\"Issue\"}}" "$(now opened 'triage::failed')"
expect skip '{"object_kind":"push"}'
expect skip "{\"object_kind\":\"issue\",$alice,\"object_attributes\":{\"iid\":1}}"

[ "$failed" -eq 0 ] && echo "triage-route: all cases pass"
exit "$failed"
