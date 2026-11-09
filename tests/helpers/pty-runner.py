"""Linux controlling-terminal runner; JSON input/output keeps tests deterministic."""
import errno
import json
import os
import pty
import re
import select
import signal
import sys
import time

with open(sys.argv[1], encoding="utf-8") as source:
    payload = json.load(source)
pid, master = pty.fork()
if pid == 0:
    os.chdir(payload["cwd"])
    env = dict(os.environ)
    env.pop("CI", None)
    env.update(payload.get("env", {}))
    os.execvpe(payload["command"][0], payload["command"], env)

output = bytearray()
sent = False
status = None
eof = False
timeout = payload.get("timeout", 6)
deadline = time.monotonic() + timeout
queries = bytearray()
completed = False


def terminate(signum, _frame):
    # Let finally clean up the controlling session when the caller cancels.
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([] if eof else [master], [], [], 0.02)
        if readable:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if chunk:
                output.extend(chunk)
                # Fish 4.1+ waits for DA1 before reading interactive input. Answer
                # each query, including queries split across PTY reads.
                queries.extend(chunk)
                consumed = 0
                for query in re.finditer(rb"\x1b\[(?:0)?c", queries):
                    os.write(master, b"\x1b[?1;2c")
                    consumed = query.end()
                queries = queries[consumed:][-3:]
            else:
                eof = True
        if not eof and not sent and payload.get("sendAt", "AGENT_READY").encode() in output:
            if payload.get("interrupt"):
                os.write(master, b"\x03")
            elif "input" in payload:
                os.write(master, payload["input"].encode())
            sent = True
        if status is None:
            waited, value = os.waitpid(pid, os.WNOHANG)
            if waited:
                status = value
        # Child exit and PTY EOF are separate: drain buffered diagnostics first.
        if status is not None and eof:
            break
    if status is None or not eof:
        raise TimeoutError(
            f"PTY command or output did not finish within {timeout:g} seconds "
            f"(input sent: {sent}, child exited: {status is not None}, EOF: {eof}). "
            f"Captured output: {output.decode('utf-8', errors='replace')!r}"
        )
    completed = True
finally:
    if not completed:
        # Descendants can hold the PTY open even after its session leader exits.
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if status is None:
            os.waitpid(pid, 0)
    os.close(master)

code = os.waitstatus_to_exitcode(status)
print(json.dumps({
    "exitCode": 128 - code if code < 0 else code,
    "output": output.decode("utf-8", errors="replace"),
}))
