"""Linux controlling-terminal runner; JSON input/output keeps tests deterministic."""
import errno
import json
import os
import pty
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
deadline = time.monotonic() + 6
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
            else:
                eof = True
        if not eof and not sent and b"AGENT_READY" in output:
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
        raise TimeoutError("PTY command or output did not finish within 6 seconds")
finally:
    if status is None:
        os.killpg(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(master)

code = os.waitstatus_to_exitcode(status)
print(json.dumps({
    "exitCode": 128 - code if code < 0 else code,
    "output": output.decode("utf-8", errors="replace"),
}))
