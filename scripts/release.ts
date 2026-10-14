import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execa } from "execa";
import { packageManager, version } from "../package.json";

const root = fileURLToPath(new URL("../", import.meta.url));
const number = "(?:0|[1-9][0-9]*)";
const releaseVersion = new RegExp(`^${number}\\.${number}\\.${number}(?:-rc\\.${number})?$`, "u");
const target = "bun-linux-x64";

export function validateReleaseTag(tag: string, packageVersion: string): void {
  if (!releaseVersion.test(packageVersion) || tag !== `v${packageVersion}`) {
    throw new Error("Release tag must match the package's stable or numbered rc version exactly.");
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execa("git", args, { cwd, env: { GIT_OPTIONAL_LOCKS: "0" } })).stdout;
}

export async function verifyTaggedCommit(cwd: string, tag: string): Promise<string> {
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  let tagged: string;
  try {
    tagged = await git(cwd, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  } catch {
    throw new Error("Release tag is missing from this checkout.");
  }
  if (tagged !== head) throw new Error("Release tag does not identify the checked-out commit.");
  if (await git(cwd, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("Tagged release requires a clean source checkout.");
  }
  return head;
}

async function build(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { tag: { type: "string" }, outdir: { type: "string" } },
    allowPositionals: false,
  });
  if (packageManager !== `bun@${Bun.version}`) throw new Error(`Build requires ${packageManager}.`);
  const tag = values.tag;
  if (tag !== undefined) validateReleaseTag(tag, version);
  const sourceCommit = tag === undefined
    ? await git(root, ["rev-parse", "HEAD"])
    : await verifyTaggedCommit(root, tag);
  const sourceDirty = (await git(root, ["status", "--porcelain", "--untracked-files=all"])) !== "";
  const outdir = resolve(root, values.outdir ?? "dist/release");
  const binaryName = `timber-v${version}-linux-x64`;
  await mkdir(outdir, { recursive: true });
  await execa(process.execPath, [
    "--no-env-file", "build", "src/index.ts", "--compile", `--target=${target}`,
    "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
    "--outfile", join(outdir, binaryName),
  ], { cwd: root, stdio: "inherit" });
  await writeFile(join(outdir, "build-info.json"), `${JSON.stringify({
    version, tag: tag ?? null, sourceCommit, sourceDirty, bunVersion: Bun.version, target,
  }, null, 2)}\n`);
  const sums = await Promise.all([binaryName, "build-info.json"].map(async name => {
    const digest = createHash("sha256").update(await readFile(join(outdir, name))).digest("hex");
    return `${digest}  ${name}\n`;
  }));
  await writeFile(join(outdir, "SHA256SUMS"), sums.join(""));
  process.stdout.write(`Release candidate: ${binaryName}\n`);
}

if (import.meta.main) {
  try {
    await build();
  } catch (error) {
    // Avoid printing subprocess output or arbitrary configuration values.
    const message = error instanceof Error && !("command" in error)
      ? error.message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?")
      : "Release build failed; check the toolchain and Git checkout.";
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  }
}
