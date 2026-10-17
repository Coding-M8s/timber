import { expect, test } from "bun:test";
import { parseCursorModels, parseCodexModels, applyArenaEffort } from "../src/arena/models";

test("Cursor models keep native IDs and expose only variants actually listed", () => {
  const models = parseCursorModels("Available models\nauto - Auto (current, default)\nsonnet-high - Sonnet High\nsonnet-medium - Sonnet Medium\nsonnet-high-fast - Sonnet High Fast\nsonnet-ultra - Sonnet Ultra\nTip: use --model <id>\n");
  expect(models.map(m => m.value)).toEqual(["auto", "sonnet-high", "sonnet-medium", "sonnet-high-fast", "sonnet-ultra"]);
  expect(models[1]?.efforts).toEqual(["medium", "high", "ultra"]);
  expect(applyArenaEffort("cursor", "sonnet-ultra", "ultra", models)).toEqual({ model: "sonnet-ultra", args: [] });
  expect(models[3]?.efforts).toEqual(["high"]);
  expect(applyArenaEffort("cursor", "sonnet-high", "high", models)).toEqual({ model: "sonnet-high", args: [] });
  expect(() => applyArenaEffort("cursor", "sonnet-high", "medium", models)).toThrow(/conflict/i);
  expect(() => applyArenaEffort("cursor", "sonnet-high", "max", models)).toThrow(/supported/i);
});

test("Codex cache reads capability fields without manufacturing effort levels", () => {
  const models = parseCodexModels(JSON.stringify({ identity: "not a model", models: [
    { slug: "gpt-sol", display_name: "Sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
    { slug: "hidden", visibility: "hide" },
    { slug: "bad\nvalue", display_name: "Bad" },
  ] }));
  expect(models.map(m => [m.value, m.efforts])).toEqual([["gpt-sol", ["low", "high"]]]);
  expect(applyArenaEffort("codex", "gpt-sol", "high", models).args).toEqual(["--config", 'model_reasoning_effort="high"']);
  expect(() => applyArenaEffort("codex", "gpt-sol", "max", models)).toThrow(/supported/i);
  expect(() => applyArenaEffort("codex", null, "high", models)).toThrow(/model/i);
});

test("Claude effort arguments require model-specific capabilities", () => {
  expect(() => applyArenaEffort("claude", "sonnet", "high", [{ value: "sonnet", label: "Sonnet" }])).toThrow(/unknown/);
  expect(applyArenaEffort("claude", "sonnet", "medium", [{ value: "sonnet", label: "Sonnet", efforts: ["low", "medium"] }]).args).toEqual(["--effort", "medium"]);
});

test("Claude CLI help does not establish effort support for model aliases", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { execa } = await import("execa");
  const directory = await mkdtemp(join(tmpdir(), "timber claude metadata "));
  try {
    await writeFile(join(directory, "claude"), "#!/bin/sh\nprintf '%s\\n' '--model <id>' '--effort <level> (low, medium, high, xhigh, max)'\n", { mode: 0o700 });
    const { stdout } = await execa(process.execPath, ["-e", `
      import { discoverArenaModels, applyArenaEffort } from "./src/arena/models";
      const catalog = await discoverArenaModels("claude");
      let rejected = false;
      try { applyArenaEffort("claude", "sonnet", "xhigh", catalog.models); }
      catch { rejected = true; }
      console.log(JSON.stringify({ catalog, rejected }));
    `], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { PATH: directory + ":" + process.env.PATH, ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6" } });
    const { catalog, rejected } = JSON.parse(stdout);
    expect(catalog.models.map((model: { value: string }) => model.value)).toContain("sonnet");
    expect(catalog.models.every((model: { efforts?: string[] }) => !model.efforts?.length)).toBe(true);
    expect(rejected).toBe(true);
    expect(catalog.warning).toMatch(/model-specific|capabilit/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
