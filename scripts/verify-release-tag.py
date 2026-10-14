"""Read-only GitHub tag identity gate for an already-built release candidate."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys


def api_object(endpoint):
    result = subprocess.run(
        ["gh", "api", endpoint], check=True, capture_output=True, text=True, timeout=30
    )
    response = json.loads(result.stdout)
    target = response.get("object") if isinstance(response, dict) else None
    if not isinstance(target, dict) or not re.fullmatch(r"[0-9a-f]{40}", target.get("sha", "")):
        raise ValueError("GitHub returned an invalid tag target.")
    return target


def verify(args):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
        raise ValueError("Repository must be owner/name.")
    number = r"(?:0|[1-9][0-9]*)"
    if not re.fullmatch(rf"v{number}\.{number}\.{number}(?:-rc\.{number})?", args.tag):
        raise ValueError("Invalid release tag.")
    metadata = json.loads(Path(args.build_info).read_text())
    if not isinstance(metadata, dict) or metadata.get("tag") != args.tag or metadata.get("sourceDirty") is not False:
        raise ValueError("Candidate must identify this tag and clean source.")
    commit = metadata.get("sourceCommit", "")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Candidate source commit is invalid.")
    target = api_object(f"repos/{args.repo}/git/ref/tags/{args.tag}")
    seen = set()
    for _ in range(9):
        if target.get("type") == "commit":
            if target["sha"] != commit:
                raise ValueError("Remote tag no longer identifies the verified candidate commit.")
            print(f"Verified remote tag {args.tag}: {commit}")
            return
        if target.get("type") != "tag" or target["sha"] in seen:
            raise ValueError("Remote tag does not resolve to a commit.")
        seen.add(target["sha"])
        target = api_object(f"repos/{args.repo}/git/tags/{target['sha']}")
    raise ValueError("Remote annotated tag chain is too deep.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--build-info", required=True)
    try:
        verify(parser.parse_args())
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
        # Never echo GitHub response bodies, auth failures, or tokens.
        message = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else "Unable to read candidate metadata or remote tag."
        print(f"Release tag verification failed: {message}", file=sys.stderr)
        sys.exit(1)
