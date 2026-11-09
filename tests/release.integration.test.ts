import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execa } from "execa";
import { version } from "../package.json";
import { readCredentialStore, withCredentialSave } from "../src/jira/credentials";
import { git, withRepository } from "./helpers/git";

const root = fileURLToPath(new URL("../", import.meta.url));
const runner = join(root, "scripts/smoke-release.py");
let directory: string;
let binary: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "timber release test "));
  binary = join(directory, `timber-v${version}-linux-x64`);
  await execa(process.execPath, ["--no-env-file", "scripts/release.ts", "--outdir", directory], {
    cwd: root, timeout: 60_000,
  });
}, 65_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test("installed Linux standalone resolves Jira using saved credentials without .env or Jira environment (mocked HTTPS)", async () => {
  await withRepository(async (primary, workspace) => {
    const bin = join(workspace, "installed/bin"); await mkdir(bin, { recursive: true });
    const installed = join(bin, "timber"); await copyFile(binary, installed); await chmod(installed, 0o755);
    const env = { HOME: workspace, XDG_CONFIG_HOME: join(workspace, "xdg/config"), XDG_STATE_HOME: join(workspace, "xdg/state"),
      JIRA_EMAIL: undefined, JIRA_API_TOKEN: undefined, CI: "true", PATH: "/usr/bin:/bin" };
    await mkdir(join(env.XDG_STATE_HOME, "timber"), { recursive: true });
    await writeFile(join(env.XDG_STATE_HOME, "timber/setup-hint-shown"), "1\n");
    const store = await readCredentialStore(env);
    store.set({ siteUrl: "https://example.atlassian.net" }, { email: "standalone@example.invalid", token: "STANDALONE_SYNTHETIC" });
    await withCredentialSave(store, async () => {});
    await writeFile(join(primary, ".timber.toml"), '[jira]\nsite_url = "https://example.atlassian.net"\n');
    const key = join(workspace, "test-tls.key"); const cert = join(workspace, "test-tls.pem");
    await execa("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
      "-subj", "/CN=example.atlassian.net", "-addext", "subjectAltName=DNS:example.atlassian.net", "-days", "1"]);
    const requests: { path: string; authorization: string | null }[] = [];
    const https = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: await readFile(key), cert: await readFile(cert) },
      fetch(request) {
        requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
        return Response.json({ key: "SYN-54", fields: { summary: "Saved credential standalone", status: { statusCategory: { key: "new" } } } });
      },
    });
    const proxy = createServer(); const tunnels = new Set<ReturnType<typeof connect>>();
    proxy.on("connect", (request, client, head) => {
      if (request.url !== "example.atlassian.net:443") { client.destroy(); return; }
      const upstream = connect(https.port!, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      tunnels.add(upstream); upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy()); client.on("close", () => { upstream.destroy(); tunnels.delete(upstream); });
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address(); if (!address || typeof address === "string") throw new Error("Proxy failed to bind");
    try {
      const result = await execa(installed, ["new", "SYN-54", "--base", "trunk", "--no-editor", "--no-agent"], {
        cwd: primary, reject: false, timeout: 15_000,
        env: { ...env, HTTPS_PROXY: `http://127.0.0.1:${address.port}`, https_proxy: `http://127.0.0.1:${address.port}`,
          ALL_PROXY: undefined, all_proxy: undefined, NO_PROXY: "", no_proxy: "", NODE_EXTRA_CA_CERTS: cert },
      });
      expect(result.stderr).toBe(""); expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("SYN-54-saved-credential-standalone");
      expect(result.stdout).not.toContain("STANDALONE_SYNTHETIC");
      expect(requests).toEqual([{ path: "/rest/api/3/issue/SYN-54",
        authorization: `Basic ${Buffer.from("standalone@example.invalid:STANDALONE_SYNTHETIC").toString("base64")}` }]);
      expect(await git(primary, "show-ref", "--verify", "refs/heads/SYN-54-saved-credential-standalone")).toContain("refs/heads/SYN-54-saved-credential-standalone");
      expect(await git(primary, "worktree", "list", "--porcelain")).toContain("branch refs/heads/SYN-54-saved-credential-standalone");
    } finally {
      for (const tunnel of tunnels) tunnel.destroy();
      proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
      await https.stop(true);
    }
  });
}, 25_000);

test("release output identifies source and passes checksum validation", async () => {
  const info = JSON.parse(await readFile(join(directory, "build-info.json"), "utf8"));
  expect(info.version).toBe(version);
  expect(info.license).toBe("SEE LICENSE IN LICENSE");
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"]) {
    expect(await readFile(join(directory, name), "utf8")).toBe(await readFile(join(root, name), "utf8"));
  }
  const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
  expect(sums).toContain("  LICENSE\n");
  expect(sums).toContain("  THIRD_PARTY_NOTICES.txt\n");
  expect(info.sourceCommit).toBe((await execa("git", ["rev-parse", "HEAD"], { cwd: root })).stdout);
  expect(info.target).toBe("bun-linux-x64");
  expect(info.bunVersion).toBe("1.4.2");
  expect(info.tag).toBeNull();
  expect(typeof info.sourceDirty).toBe("boolean");
  await execa("sha256sum", ["-c", "SHA256SUMS"], { cwd: directory });
});

test("standalone rebuild produces identical bytes with the same inputs", async () => {
  const hash = async () => createHash("sha256").update(await readFile(binary)).digest("hex");
  const first = await hash();
  const metadata = await readFile(join(directory, "build-info.json"), "utf8");
  await execa(process.execPath, ["--no-env-file", "scripts/release.ts", "--outdir", directory], {
    cwd: root, timeout: 60_000,
  });
  expect(await hash()).toBe(first);
  expect(await readFile(join(directory, "build-info.json"), "utf8")).toBe(metadata);
}, 65_000);

test("compiled CLI passes real lifecycle, preservation, setup and terminal checks", async () => {
  const result = await execa("python3", [runner, "--binary", binary, "--expected-version", version], {
    timeout: 60_000, reject: false,
  });
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('"result": "passed"');
}, 65_000);

test("smoke verifier refuses wrong versions, missing executables and failing fixtures", async () => {
  for (const [path, expected, diagnostic] of [
    [binary, "999.0.0", "Version mismatch"],
    [join(directory, "missing"), version, "Release binary"],
  ]) {
    const result = await execa("python3", [runner, "--binary", path!, "--expected-version", expected!], {
      reject: false, timeout: 5_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(diagnostic!);
  }
  const fixture = join(directory, "fails");
  await writeFile(fixture, "#!/bin/sh\nexit 9\n");
  await chmod(fixture, 0o755);
  const result = await execa("python3", [runner, "--binary", fixture, "--expected-version", version], {
    reject: false, timeout: 5_000,
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Version command failed");
});
