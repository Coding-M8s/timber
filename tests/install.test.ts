import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

// The installer is a POSIX shell script; Windows uses the PowerShell steps instead.
const posix = process.platform !== "win32";
const script = fileURLToPath(new URL("../install.sh", import.meta.url));

type Bytes = Uint8Array<ArrayBuffer>;
type Release = Map<string, Bytes>;
let root: string;
let certificate: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let latest = "v1.2.3";
const releases = new Map<string, Release>();
const requests: string[] = [];
let sequence = 0;

const bytes = (text: string): Bytes => new TextEncoder().encode(text);
const sha256 = (data: Bytes) => createHash("sha256").update(data).digest("hex");
const fakeTimber = (version: string) => bytes(`#!/bin/sh\necho "${version}"\n`);

function assetNames(tag: string, target: string) {
  const linux = target === "linux-x64";
  return {
    executable: `timber-${tag}-${target}`,
    metadata: linux ? "build-info.json" : `build-info-${target}.json`,
    checksums: linux ? "SHA256SUMS" : `SHA256SUMS-${target}`,
  };
}

/** Publishes a fixture release shaped like the real assets, with a shell script standing in for the executable. */
function publish(tag: string, target = "linux-x64", executable = fakeTimber(tag.slice(1))): Release {
  const names = assetNames(tag, target);
  const files: Release = releases.get(tag) ?? new Map();
  files.set(names.executable, executable);
  files.set(names.metadata, bytes(JSON.stringify({ tag, target })));
  files.set("LICENSE", bytes("license\n"));
  files.set("THIRD_PARTY_NOTICES.txt", bytes("notices\n"));
  const covered = [names.executable, names.metadata, "LICENSE", "THIRD_PARTY_NOTICES.txt"];
  files.set(names.checksums, bytes(covered.map(name => `${sha256(files.get(name)!)}  ${name}\n`).join("")));
  releases.set(tag, files);
  return files;
}

interface Machine {
  os?: string;
  arch?: string;
  glibc?: boolean;
  env?: Record<string, string>;
  shell?: string;
  pathPrefix?: string[];
  pathSuffix?: string[];
}

/** Runs the installer in an isolated HOME with `uname` and `getconf` doubles, so every platform path runs on any host. */
async function install(machine: Machine = {}) {
  const sandbox = join(root, `run-${++sequence}`);
  const home = join(sandbox, "home");
  const tools = join(sandbox, "tools");
  const temporary = join(sandbox, "tmp");
  for (const directory of [home, tools, temporary]) await mkdir(directory, { recursive: true });
  const { os = "Linux", arch = "x86_64", glibc = true } = machine;
  await writeFile(join(tools, "uname"), `#!/bin/sh\ncase "$1" in -s) echo "${os}";; -m) echo "${arch}";; *) exit 1;; esac\n`);
  await writeFile(join(tools, "getconf"), `#!/bin/sh\n${glibc ? 'echo "glibc 2.39"' : "exit 1"}\n`);
  await chmod(join(tools, "uname"), 0o755);
  await chmod(join(tools, "getconf"), 0o755);
  const path = [...(machine.pathPrefix ?? []), tools, "/usr/bin", "/bin", ...(machine.pathSuffix ?? [])].join(":");
  const result = await execa(machine.shell ?? "sh", [script], {
    extendEnv: false, reject: false,
    env: { HOME: home, PATH: path, TMPDIR: temporary, CURL_CA_BUNDLE: certificate, TIMBER_RELEASES_URL: base, ...machine.env },
  });
  return { result, home, temporary, installed: join(home, ".local/bin/timber"), output: `${result.stdout}\n${result.stderr}` };
}

async function existingInstall(directory: string): Promise<Bytes> {
  const previous = fakeTimber("0.0.1");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "timber"), previous, { mode: 0o755 });
  return previous;
}

beforeAll(async () => {
  if (!posix) return;
  root = await mkdtemp(join(tmpdir(), "timber-install-test-"));
  const key = join(root, "tls.key");
  certificate = join(root, "tls.pem");
  await execa("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate,
    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-days", "1"]);
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0, tls: { key: await readFile(key), cert: await readFile(certificate) },
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/releases/latest") return Response.redirect(`${base}/tag/${latest}`, 302);
      if (path.startsWith("/releases/tag/")) return new Response("release page");
      const [, tag, asset] = /^\/releases\/download\/([^/]+)\/([^/]+)$/.exec(path) ?? [];
      const body = tag && asset ? releases.get(tag)?.get(asset) : undefined;
      return body ? new Response(body) : new Response("not found", { status: 404 });
    },
  });
  base = `https://127.0.0.1:${server.port}/releases`;
});

afterAll(async () => {
  if (!posix) return;
  await server.stop(true);
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  releases.clear();
  requests.length = 0;
  latest = "v1.2.3";
  publish("v1.2.3");
});

test.skipIf(!posix)("installs the latest release, verifies it, and cleans up", async () => {
  const { result, installed, temporary, output } = await install();
  expect(output).toContain("Installed Timber 1.2.3");
  expect(result.exitCode).toBe(0);
  expect((await execa(installed, ["--version"])).stdout).toBe("1.2.3");
  expect(requests).toEqual([
    "/releases/latest", "/releases/tag/v1.2.3",
    "/releases/download/v1.2.3/timber-v1.2.3-linux-x64", "/releases/download/v1.2.3/build-info.json",
    "/releases/download/v1.2.3/SHA256SUMS", "/releases/download/v1.2.3/LICENSE",
    "/releases/download/v1.2.3/THIRD_PARTY_NOTICES.txt",
  ]);
  expect(await readdir(temporary)).toEqual([]);
  expect(await readdir(join(installed, ".."))).toEqual(["timber"]);
  expect(output).toContain("is not on your PATH");
  expect(output).not.toContain("beta");
});

test.skipIf(!posix)("works when piped to the shell, as the documented command does", async () => {
  const home = join(root, "piped-home");
  const result = await execa("sh", [], {
    input: await readFile(script, "utf8"), extendEnv: false, reject: false,
    env: { HOME: home, PATH: "/usr/bin:/bin", CURL_CA_BUNDLE: certificate, TIMBER_RELEASES_URL: base, TIMBER_VERSION: "v1.2.3" },
  });
  // The real `uname` runs here, so only assert the result on the platform the fixture publishes.
  if (process.platform === "linux" && process.arch === "x64") {
    expect(result.stderr).toBe("");
    expect((await execa(join(home, ".local/bin/timber"), ["--version"])).stdout).toBe("1.2.3");
  } else {
    expect(result.exitCode).toBe(1);
  }
});

for (const shell of ["dash", "bash"]) {
  test.skipIf(!posix || Bun.which(shell) === null)(`runs under ${shell}`, async () => {
    const { result, installed } = await install({ shell });
    expect(result.stderr).toBe("");
    expect((await execa(installed, ["--version"])).stdout).toBe("1.2.3");
  });
}

test.skipIf(!posix)("TIMBER_VERSION pins a release without asking for the latest", async () => {
  publish("v1.0.0-rc.2");
  const { result, installed } = await install({ env: { TIMBER_VERSION: "v1.0.0-rc.2" } });
  expect(result.stderr).toBe("");
  expect((await execa(installed, ["--version"])).stdout).toBe("1.0.0-rc.2");
  expect(requests).not.toContain("/releases/latest");
});

for (const value of ["1.2.3", "latest", "v1.2", "v01.2.3", "v1.2.3-dev.0", "v1.2.3;touch sentinel", "v1.2.3\nv1.2.3", "../v1.2.3", "v1.2.3/../x"]) {
  test.skipIf(!posix)(`rejects TIMBER_VERSION ${JSON.stringify(value)} before any download`, async () => {
    const { result, home, output } = await install({ env: { TIMBER_VERSION: value } });
    expect(result.exitCode).toBe(1);
    expect(output).toContain("TIMBER_VERSION must be a release tag");
    expect(requests).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  });
}

test.skipIf(!posix)("TIMBER_INSTALL_DIR chooses the directory and must be absolute", async () => {
  const directory = join(root, "custom dir with spaces", "bin");
  const chosen = await install({ env: { TIMBER_INSTALL_DIR: directory } });
  expect(chosen.result.stderr).toBe("");
  expect((await execa(join(directory, "timber"), ["--version"])).stdout).toBe("1.2.3");
  expect(await readdir(chosen.home)).toEqual([]);

  requests.length = 0;
  const relative = await install({ env: { TIMBER_INSTALL_DIR: "relative/bin" } });
  expect(relative.result.exitCode).toBe(1);
  expect(relative.output).toContain("must be an absolute path");
  expect(requests).toEqual([]);
});

for (const [arch, target] of [["arm64", "darwin-arm64"], ["x86_64", "darwin-x64"]] as const) {
  test.skipIf(!posix)(`macOS ${arch} uses the ${target} assets and says it is beta`, async () => {
    publish("v1.2.3", target);
    const { result, installed, output } = await install({ os: "Darwin", arch });
    expect(result.stderr).toBe("");
    expect((await execa(installed, ["--version"])).stdout).toBe("1.2.3");
    expect(requests).toContain(`/releases/download/v1.2.3/timber-v1.2.3-${target}`);
    expect(requests).toContain(`/releases/download/v1.2.3/SHA256SUMS-${target}`);
    expect(requests).toContain(`/releases/download/v1.2.3/build-info-${target}.json`);
    expect(output).toContain("macOS support is beta");
  });
}

for (const [name, machine, message] of [
  ["Linux arm64", { arch: "aarch64" }, "Linux aarch64 is not supported"],
  ["Linux without glibc", { glibc: false }, "does not use glibc"],
  ["macOS on an unknown processor", { os: "Darwin", arch: "ppc" }, "macOS ppc is not supported"],
  ["Git Bash on Windows", { os: "MINGW64_NT-10.0-19045" }, "Windows is not supported by this installer"],
  ["FreeBSD", { os: "FreeBSD", arch: "amd64" }, "FreeBSD is not supported"],
] as const) {
  test.skipIf(!posix)(`refuses ${name} before any download`, async () => {
    const { result, home, output } = await install(machine);
    expect(result.exitCode).toBe(1);
    expect(output).toContain(message);
    expect(requests).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  });
}

test.skipIf(!posix)("refuses a releases URL that is not https", async () => {
  const { result, output } = await install({ env: { TIMBER_RELEASES_URL: base.replace("https://", "http://") } });
  expect(result.exitCode).toBe(1);
  expect(output).toContain("must start with https://");
  expect(requests).toEqual([]);
});

const failures: [string, (files: Release) => void, string][] = [
  ["a corrupted executable", files => { files.set("timber-v1.2.3-linux-x64", fakeTimber("6.6.6")); }, "checksum verification failed"],
  ["a truncated executable", files => { files.set("timber-v1.2.3-linux-x64", files.get("timber-v1.2.3-linux-x64")!.slice(0, 5)); }, "checksum verification failed"],
  ["corrupted notices", files => { files.set("THIRD_PARTY_NOTICES.txt", bytes("changed\n")); }, "checksum verification failed"],
  ["a missing executable", files => { files.delete("timber-v1.2.3-linux-x64"); }, "could not download timber-v1.2.3-linux-x64"],
  ["a missing checksum file", files => { files.delete("SHA256SUMS"); }, "could not download SHA256SUMS"],
  ["a missing license", files => { files.delete("LICENSE"); }, "could not download LICENSE"],
  ["a checksum file that omits the executable", files => {
    files.set("SHA256SUMS", bytes(`${sha256(files.get("LICENSE")!)}  LICENSE\n`));
  }, "SHA256SUMS does not list timber-v1.2.3-linux-x64"],
];
for (const [name, damage, message] of failures) {
  test.skipIf(!posix)(`${name} installs nothing and keeps the existing install`, async () => {
    damage(releases.get("v1.2.3")!);
    const home = join(root, `preserved-${++sequence}`);
    const directory = join(home, "bin");
    const previous = await existingInstall(directory);
    const { result, temporary, output } = await install({ env: { TIMBER_INSTALL_DIR: directory } });
    expect(output).toContain(message);
    expect(output).not.toContain("Installed Timber");
    expect(result.exitCode).toBe(1);
    expect(new Uint8Array(await readFile(join(directory, "timber")))).toEqual(previous);
    expect(await readdir(directory)).toEqual(["timber"]);
    expect(await readdir(temporary)).toEqual([]);
  });
}

for (const [name, executable, message] of [
  ["reports another version", fakeTimber("9.9.9"), "reports version 9.9.9, expected 1.2.3"],
  ["cannot run", bytes("#!/bin/sh\nexit 1\n"), "did not run on this machine"],
] as const) {
  test.skipIf(!posix)(`a verified executable that ${name} does not replace the existing install`, async () => {
    publish("v1.2.3", "linux-x64", executable);
    const directory = join(root, `unrunnable-${++sequence}`, "bin");
    const previous = await existingInstall(directory);
    const { result, output } = await install({ env: { TIMBER_INSTALL_DIR: directory } });
    expect(output).toContain(message);
    expect(result.exitCode).toBe(1);
    expect(new Uint8Array(await readFile(join(directory, "timber")))).toEqual(previous);
    expect(await readdir(directory)).toEqual(["timber"]);
  });
}

test.skipIf(!posix)("no published release gives a clear error", async () => {
  latest = "";
  const { result, home, output } = await install();
  expect(result.exitCode).toBe(1);
  expect(output).toContain("could not read a release tag");
  expect(await readdir(home)).toEqual([]);
});

test.skipIf(!posix)("replaces an older install and stays quiet when it is first on PATH", async () => {
  const directory = join(root, `upgrade-${++sequence}`, "bin");
  await existingInstall(directory);
  const { result, output } = await install({ env: { TIMBER_INSTALL_DIR: directory }, pathPrefix: [directory] });
  expect(result.stderr).toBe("");
  expect((await execa(join(directory, "timber"), ["--version"])).stdout).toBe("1.2.3");
  expect(output).not.toContain("Warning");
  expect(output).not.toContain("is not on your PATH");
});

test.skipIf(!posix)("warns when another timber earlier on PATH hides the install", async () => {
  const linked = join(root, `linked-${++sequence}`);
  await existingInstall(linked);
  const directory = join(root, `shadowed-${++sequence}`, "bin");
  const { result, output } = await install({ env: { TIMBER_INSTALL_DIR: directory }, pathPrefix: [linked], pathSuffix: [directory] });
  expect(result.exitCode).toBe(0);
  expect(output).toContain(`another timber at ${join(linked, "timber")} comes first on your PATH`);
  expect((await execa(join(directory, "timber"), ["--version"])).stdout).toBe("1.2.3");
});

test.skipIf(!posix)("a truncated script never downloads or installs anything", async () => {
  const source = await readFile(script, "utf8");
  const end = source.lastIndexOf("timber_install");
  for (let cut = 200; cut < end; cut += Math.floor(end / 12)) {
    const home = join(root, `truncated-${++sequence}`);
    await mkdir(home);
    await execa("sh", [], {
      input: source.slice(0, cut), extendEnv: false, reject: false,
      env: { HOME: home, PATH: "/usr/bin:/bin", CURL_CA_BUNDLE: certificate, TIMBER_RELEASES_URL: base },
    });
    expect(requests).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  }
});
