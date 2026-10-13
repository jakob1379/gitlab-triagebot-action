# What scripts/triage.sh does with a GitLab webhook body: "triage", "implement",
# "cleanup" or "skip". $bot is the triage token's own username; $issue[0] is the
# issue as it is now, which a run queued behind another may see changed since
# the event.
def retriageable:
  ["triage::needs-triage", "triage::needs-reproduction", "triage::unable-to-reproduce", "triage::unable-to-fix", "triage::failed", "triage::needs-approval"];
def has($label): any(.[]?.title; . == $label);

$issue[0] as $now
| def added($label): (.changes.labels.current | has($label)) and (.changes.labels.previous | has($label) | not)
    and any($now.labels[]?; . == $label);
if .user.username == $bot then "skip"
elif .object_kind == "issue" and .object_attributes.action == "close" then
  if $now.state == "closed" then "cleanup" else "skip" end
elif $now.state != "opened" then "skip"
elif .object_kind == "issue" then
  if .object_attributes.action == "update" then
    if added("triage::needs-triage") then "triage"
    elif added("triage::approved") and (.changes.labels.previous | has("triage::needs-approval")) then "implement"
    else "skip" end
  else
    if .object_attributes.action == "open" and any($now.labels[]?; startswith("triage::") and . != "triage::needs-triage")
    then "skip"
    else {open: "triage", reopen: "triage"}[.object_attributes.action // ""] // "skip"
    end
  end
elif .object_kind == "note"
  and .object_attributes.noteable_type == "Issue"
  and .object_attributes.action == "create"
  and (.object_attributes.internal | not)
  and any($now.labels[]?; IN(retriageable[]))
then "triage"
else "skip"
end
