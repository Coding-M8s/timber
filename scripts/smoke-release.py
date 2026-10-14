"""Exercise a release executable in disposable repositories, without a JS runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(args, cwd, env, code=0):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env,
                            capture_output=True, text=True, timeout=20)
    check(result.returncode == code,
          f"{Path(str(args[0])).name} {list(map(str, args[1:3]))}: "
          f"expected exit {code}, got {result.returncode}: {result.stderr.strip()}")
    return result


def smoke(binary, expected, lab):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("GIT_", "JIRA_", "TIMBER_", "BUN_"))
           and key not in ("NODE_OPTIONS", "NODE_EXTRA_CA_CERTS")}
    env.update(CI="true", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0",
               GIT_AUTHOR_NAME="Timber Smoke", GIT_COMMITTER_NAME="Timber Smoke",
               GIT_AUTHOR_EMAIL="smoke@example.invalid",
               GIT_COMMITTER_EMAIL="smoke@example.invalid")
    templates = lab / "empty-template"
    templates.mkdir()
    env["GIT_TEMPLATE_DIR"] = str(templates)
    # Relocation proves no executable-path or source-checkout dependency.
    relocated = lab / "binary with spaces" / "timber"
    relocated.parent.mkdir()
    shutil.copy2(binary, relocated)
    binary = relocated
    version = subprocess.run([str(binary), "--version"], cwd=lab, env=env,
                             capture_output=True, text=True, timeout=5)
    check(version.returncode == 0, "Version command failed")
    check(version.stdout == expected + "\n" and not version.stderr, "Version mismatch")
    for args in ([], ["--help"], *([name, "--help"] for name in ("new", "open", "ls", "done"))):
        result = run([binary, *args], lab, env)
        check("Usage: timber" in result.stdout and not result.stderr, "Help output failed")
    run([binary, "unknown"], lab, env, 1)
    run([binary, "ls"], lab, env, 1)

    primary = lab / "primary repo"
    primary.mkdir()
    trees = lab / "primary repo-worktrees"

    def git(*args, cwd=primary):
        return run(["git", *args], cwd, env).stdout.strip()

    def cli(*args, cwd=primary, code=0, extra=None):
        result = run([binary, *args], cwd, {**env, **(extra or {})}, code)
        if code == 0:
            check(not result.stderr, f"Unexpected stderr: {result.stderr}")
        else:
            check(result.stderr, "Failure did not explain the problem")
        return result

    def files(path):
        values = {}
        if path.exists():
            for directory, dirs, names in os.walk(path):
                dirs[:] = [name for name in dirs if name != ".git"]
                for name in names:
                    if name != ".git":
                        file = Path(directory) / name
                        values[str(file.relative_to(path))] = file.read_bytes()
        return values

    def snapshot(*paths):
        return (git("show-ref"), git("worktree", "list", "--porcelain"),
                files(primary), [files(path) for path in paths])

    def refuses(*args, paths=()):
        before = snapshot(*paths)
        cli(*args, code=1)
        check(snapshot(*paths) == before, "Refusal changed files, refs or worktree inventory")

    def config(text):
        (primary / ".timber.toml").write_text('base_branch = "main"\n' + text)

    def ref_exists(name):
        return subprocess.run(["git", "show-ref", "--verify", "--quiet", f"refs/heads/{name}"],
                              cwd=primary, env=env, timeout=5).returncode == 0

    git("init", "--initial-branch=main")
    (primary / "tracked.txt").write_text("original\n")
    (primary / "nested").mkdir()
    (primary / "nested/README.md").write_text("nested\n")
    (primary / ".gitignore").write_text(".env\n.setup-log\n.timber.toml\nbunfig.toml\n")
    git("add", ".")
    git("commit", "-m", "create synthetic release fixture")

    # Core CLI: no integration configuration or credentials.
    cli("new", "core", "--base", "main", "--no-editor")
    core = trees / "core"
    check(core.is_dir() and ref_exists("core"), "new did not create the expected worktree/ref")
    before = snapshot(core)
    cli("open", "core", "--no-editor", cwd=primary / "nested")
    check(snapshot(core) == before, "open created or modified an existing workspace")
    listings = [cli("ls", cwd=cwd).stdout for cwd in (primary, primary / "nested", core)]
    check(len(set(listings)) == 1 and "primary\tmain\t" in listings[0], "Discovery/listing disagrees")
    refuses("new", "core", "--base", "main", paths=(core,))
    cli("done", "core", "--keep-branch")
    check(not core.exists() and ref_exists("core"), "keep-branch did not retain the local ref")
    cli("open", "core", "--no-editor")
    cli("done", "core")
    check(not core.exists() and not ref_exists("core"), "base-contained cleanup failed")
    refuses("done", "main")
    git("branch", "local-only", "main")
    cli("open", "local-only", "--no-editor")
    check((trees / "local-only").exists(), "Local branch did not materialize")

    remote = lab / "origin.git"
    git("init", "--bare", "--initial-branch=main", str(remote), cwd=lab)
    git("remote", "add", "origin", str(remote))
    git("push", "-u", "origin", "main")
    git("branch", "remote-only", "main", cwd=remote)
    cli("open", "origin/remote-only", "--no-editor")
    check(git("rev-parse", "--abbrev-ref", "remote-only@{upstream}") == "origin/remote-only",
          "Remote branch did not acquire its upstream")
    cli("done", "remote-only")
    check(git("rev-parse", "remote-only", cwd=remote), "Cleanup deleted a remote branch")

    cli("new", "published", "--base", "main", "--no-editor")
    published = trees / "published"
    (published / "tracked.txt").write_text("published feature\n")
    git("add", "tracked.txt", cwd=published)
    git("commit", "-m", "published change", cwd=published)
    git("push", "-u", "origin", "published", cwd=published)
    published_oid = git("rev-parse", "HEAD", cwd=published)
    cli("done", "published")
    check(not published.exists() and not ref_exists("published"), "Published cleanup failed")
    check(git("rev-parse", "published", cwd=remote) == published_oid, "Remote tip was not preserved")

    cli("new", "preserve", "--base", "main", "--no-editor")
    preserve = trees / "preserve"
    (preserve / "tracked.txt").write_text("modified\n")
    refuses("done", "preserve", paths=(preserve,))
    (preserve / "tracked.txt").write_text("original\n")
    (preserve / "untracked.txt").write_text("untracked\n")
    refuses("done", "preserve", paths=(preserve,))
    (preserve / "untracked.txt").unlink()
    (preserve / ".env").write_text("SYNTHETIC_IGNORED=1\n")
    refuses("done", "preserve", "--keep-ignored", paths=(preserve,))
    refuses("done", "preserve", "--keep-ignored", "--discard-ignored", paths=(preserve,))
    cli("done", "preserve")
    check(not preserve.exists() and not ref_exists("preserve"), "Default ignored cleanup failed")
    cli("new", "unpublished", "--base", "main", "--no-editor")
    unpublished = trees / "unpublished"
    (unpublished / "tracked.txt").write_text("unpublished feature\n")
    git("add", "tracked.txt", cwd=unpublished)
    git("commit", "-m", "unpublished change", cwd=unpublished)
    refuses("done", "unpublished", paths=(unpublished,))

    occupied = trees / "collision"
    occupied.mkdir()
    (occupied / "sentinel").write_text("preserve destination\n")
    refuses("new", "collision", "--base", "main", paths=(occupied,))
    config("unknown_key = true\n")
    refuses("new", "invalid-config", "--base", "main")
    (primary / ".timber.toml").unlink()
    git("remote", "set-url", "origin", str(lab / "unavailable.git"))
    cli("open", "local-only", "--no-editor")
    refuses("open", "origin/missing", "--no-editor")
    git("remote", "set-url", "origin", str(remote))

    # Runtime autoload isolation and real setup retry.
    (primary / ".env").write_text("TIMBER_SMOKE_DOTENV=loaded\n")
    (primary / "bunfig.toml").write_text("malformed = [\n")
    config('[hooks]\npost_create = ['
           + json.dumps('printf "%s\\n%s\\n%s\\n%s\\n%s\\n" "$TIMBER_REPO" "$PWD" '
                        '"$TIMBER_TASK_ID" "$TIMBER_SMOKE_DOTENV" "$SMOKE_EXPORTED" >> .setup-log')
           + ']\n')
    cli("new", "TIM-17-hooks", "--no-editor", extra={"SMOKE_EXPORTED": "exported"})
    hooked = trees / "TIM-17-hooks"
    rows = (hooked / ".setup-log").read_text().splitlines()
    check(rows == [str(primary), str(hooked), "TIM-17", "", "exported"],
          "Hook context or dotenv isolation failed")
    cli("open", "TIM-17-hooks", "--no-editor")
    check(len((hooked / ".setup-log").read_text().splitlines()) == 5, "Ordinary reopen reran setup")
    cli("open", "TIM-17-hooks", "--setup", "--no-editor")
    check(len((hooked / ".setup-log").read_text().splitlines()) == 10, "Explicit setup did not rerun")
    config('[hooks]\npost_create = ["touch retained-setup.txt", "exit 7", "touch must-not-run"]\n')
    cli("new", "failed-setup", "--no-editor", code=1)
    failed = trees / "failed-setup"
    check((failed / "retained-setup.txt").exists() and not (failed / "must-not-run").exists()
          and ref_exists("failed-setup"), "Failed setup did not preserve/stop correctly")
    config('[hooks]\npost_create = ["touch recovered"]\n')
    cli("open", str(failed), "--setup", "--no-editor")
    check((failed / "recovered").exists(), "Setup retry did not recover")

    config('[editor]\ncommand = "timber-smoke-missing-editor"\n')
    cli("new", "failed-editor", code=1)
    editor_tree = trees / "failed-editor"
    check(editor_tree.exists() and ref_exists("failed-editor"), "Editor failure lost workspace")
    opened = run([binary, "open", str(editor_tree)], primary, env)
    check(opened.stderr and "retry" in opened.stderr.lower(), "open editor failure lost retry guidance")
    cli("open", str(editor_tree), "--no-editor")

    # Shell agent fixtures require no Node/Bun; PTY helper is shared with source tests.
    agent = lab / "agent.sh"
    capture = lab / "agent-capture"
    agent.write_text('#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$TIMBER_SMOKE_CAPTURE"\n'
                     'printf "AGENT_READY\\n"\n'
                     'if [ "$1" = hold ]; then trap "exit 130" INT; while :; do sleep 0.1; done; fi\n'
                     'exit "$2"\n')
    agent.chmod(0o755)

    def agent_config(mode, status="0"):
        config('[agent]\nenabled = true\ncommand = ' + json.dumps(str(agent))
               + '\nargs = ' + json.dumps([mode, status, "literal ; $HOME"]) + '\n')

    def pty(args, interrupt=False):
        payload = lab / "pty.json"
        payload.write_text(json.dumps({"cwd": str(primary), "command": [str(binary), *args],
                                      "env": {"TIMBER_SMOKE_CAPTURE": str(capture)},
                                      "interrupt": interrupt}))
        helper = Path(__file__).resolve().parent.parent / "tests/helpers/pty-runner.py"
        return json.loads(run([sys.executable, "-B", helper, payload], primary, env).stdout)

    agent_config("exit", "7")
    result = pty(["new", "agent-exit", "--agent", "--no-editor"])
    agent_tree = trees / "agent-exit"
    check(result["exitCode"] == 7 and agent_tree.exists(), "Foreground agent exit was not propagated")
    check(capture.read_text().splitlines() == [str(agent_tree), "exit", "7", "literal ; $HOME"],
          "Agent cwd or literal arguments changed")
    agent_config("exit")
    check(pty(["open", str(agent_tree), "--agent", "--no-editor"])["exitCode"] == 0,
          "Successful agent exit failed")
    agent_config("hold")
    check(pty(["open", str(agent_tree), "--agent", "--no-editor"], True)["exitCode"] == 130,
          "Agent interrupt was not propagated")
    capture.unlink()
    cli("new", "ci-skip-agent", "--no-editor")
    check(not capture.exists(), "CI launched a configured agent")
    refuses("new", "ci-explicit-agent", "--agent", "--no-editor")
    config('[agent]\nenabled = false\ncommand = "timber-smoke-missing-agent"\n')
    result = pty(["new", "failed-agent", "--agent", "--no-editor"])
    check(result["exitCode"] == 1 and (trees / "failed-agent").exists()
          and ref_exists("failed-agent"), "Agent startup failure did not retain workspace")

    config('[jira]\nsite_url = "https://example.atlassian.net"\n')
    refuses("new", "TIM-999", "--no-editor")
    cli("new", "literal-jira-disabled", "--no-editor")
    cli("open", "local-only", "--no-editor")
    return git("--version")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--require-no-runtime", action="store_true")
    args = parser.parse_args()
    binary = args.binary.resolve()
    check(binary.is_file() and os.access(binary, os.X_OK), "Release binary is missing or not executable")
    if args.require_no_runtime:
        check(not any(shutil.which(name) for name in ("bun", "node", "npm")),
              "Clean verifier must not contain Bun, Node or npm")
    with tempfile.TemporaryDirectory(prefix="timber-release-smoke-") as directory:
        git_version = smoke(binary, args.expected_version, Path(directory))
    print(json.dumps({"result": "passed", "version": args.expected_version,
                      "os": platform.freedesktop_os_release().get("PRETTY_NAME", "Linux"),
                      "platform": platform.platform(), "architecture": platform.machine(),
                      "libc": platform.libc_ver(), "git": git_version,
                      "sha256": hashlib.sha256(binary.read_bytes()).hexdigest()}))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.TimeoutExpired, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
