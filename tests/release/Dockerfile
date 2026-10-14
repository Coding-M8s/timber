FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /verify
COPY scripts/smoke-release.py scripts/smoke-release.py
COPY tests/helpers/pty-runner.py tests/helpers/pty-runner.py
ENTRYPOINT ["python3", "-B", "/verify/scripts/smoke-release.py"]
