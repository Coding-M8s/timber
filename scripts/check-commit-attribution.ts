import { readFile } from "node:fs/promises";

const assistantName = /^(?:🤖\s*)?(?:claude|codex|chatgpt|gpt|openai|anthropic|cursor|composer|copilot|github copilot|gemini|grok|windsurf|codeium|devin|aider|amazon q|ai)(?:[\s._-]+(?:code|codex|ai|assistant|agent|bot|swe|opus|sonnet|haiku|luna|sol|astra|composer|\d[\w.-]*))*\s*(?:\[bot\])?$/iu;
const assistantEmail = /(?:^(?:[^@]*\+)?(?:claude|codex|chatgpt|copilot|cursor|gemini|grok|devin|ai)(?:\[bot\])?@users\.noreply\.github\.com$|^noreply@(?:anthropic\.com|openai\.com|cursor\.com|cursor\.sh)$)/iu;

/** Inspect attribution lines only; normal AI feature descriptions and human credits remain valid. */
export function hasAIAttribution(message: string): boolean {
  return message.split(/\r?\n/u).some(line => {
    const trailer = /^\s*(?:co[- ]?authored[- ]by|generated[- ]by|assisted[- ]by|signed[- ]off[- ]by):\s*(.+)$/iu.exec(line);
    if (trailer) {
      const identity = trailer[1]!;
      const email = /<([^<>]+)>/u.exec(identity)?.[1] ?? "";
      const name = identity.replace(/<[^<>]*>/gu, "").trim();
      return assistantName.test(name) || assistantEmail.test(email);
    }
    const generated = /^\s*(?:🤖\s*)?generated (?:with|by)\s+(.+)$/iu.exec(line);
    const name = generated?.[1]?.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1").trim();
    return name !== undefined && assistantName.test(name);
  });
}

function git(args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Cannot read commit range; ensure its history is available.");
  return result.stdout.toString();
}

async function check(args: readonly string[]): Promise<void> {
  if (args[0] === "--message-file" && args.length === 2) {
    if (hasAIAttribution(await readFile(args[1]!, "utf8")))
      throw new Error("AI coauthor/attribution signatures are prohibited. Remove the AI credit; human coauthors are allowed.");
    return;
  }
  let range = "HEAD";
  let tipOnly = true;
  if (args[0] === "--event" && args.length === 2) {
    const event = JSON.parse(await readFile(args[1]!, "utf8"));
    if (typeof event.pull_request?.body === "string" && hasAIAttribution(event.pull_request.body))
      throw new Error("AI attribution signatures are prohibited in PR descriptions.");
    const base: unknown = event.pull_request?.base?.sha ?? event.before;
    const head: unknown = event.pull_request?.head?.sha ?? event.after;
    const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
    if (typeof base !== "string" || typeof head !== "string" || !oid.test(base) || !oid.test(head))
      throw new Error("Cannot determine commits to check from CI event.");
    if (/^0+$/u.test(head)) return;
    tipOnly = false;
    if (/^0+$/u.test(base)) {
      const defaultBranch: unknown = event.repository?.default_branch;
      if (typeof defaultBranch !== "string" || !defaultBranch)
        throw new Error("Cannot determine new branch base from CI event.");
      range = event.ref === `refs/heads/${defaultBranch}` ? head
        : `${git(["merge-base", `refs/remotes/origin/${defaultBranch}`, head]).trim()}..${head}`;
    } else range = `${base}..${head}`;
  } else if (args.length === 1 && args[0] === "--all-history") {
    tipOnly = false;
  } else if (args.length) {
    throw new Error("Usage: check-commit-attribution.ts [--message-file <path> | --event <path> | --all-history]");
  }
  const fields = git(["log", "--format=%H%x00%B%x00", ...(tipOnly ? ["-1"] : []), "--end-of-options", range]).split("\0");
  const rejected: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2)
    if (hasAIAttribution(fields[i + 1]!)) rejected.push(fields[i]!.trim().slice(0, 12));
  if (rejected.length) throw new Error(`AI attribution found in commits: ${rejected.join(", ")}. Commit messages were not changed.`);
}

if (import.meta.main) {
  try { await check(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Cannot check commit attribution.");
    process.exitCode = 1;
  }
}
