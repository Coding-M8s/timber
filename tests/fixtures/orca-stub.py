"""A local CLI boundary double; executes Timber's generated bootstrap in a real process."""
import json
import os
import subprocess
import sys

args = sys.argv[1:]
cwd = os.getcwd()
worktree_id = "test-repo::" + cwd
if args[0] == "status":
    result = {"target": {"kind": "local"}, "app": {"running": True},
              "runtime": {"state": "ready", "reachable": True}}
elif args[:2] == ["worktree", "show"]:
    result = {"worktree": {"id": worktree_id, "path": cwd, "hostId": "local"}}
elif args[:2] == ["terminal", "create"]:
    assert args[args.index("--worktree") + 1] == "id:" + worktree_id
    command = args[args.index("--command") + 1]
    with open(os.path.join(cwd, "editor-output"), "ab") as output:
        subprocess.Popen(["/bin/sh", "-c", command], cwd=cwd,
                         stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                         start_new_session=True)
    result = {"terminal": {"handle": "term_test", "worktreeId": worktree_id,
                           "executionHostId": "local", "surface": "visible"}}
elif args[:2] == ["terminal", "switch"]:
    assert args[args.index("--terminal") + 1] == "term_test"
    with open(os.path.join(cwd, "editor-selected"), "w") as selected:
        selected.write("term_test")
    result = {"terminal": {"handle": "term_test", "worktreeId": worktree_id}}
else:
    raise AssertionError("unexpected adapter command")
print(json.dumps({"ok": True, "result": result}))
