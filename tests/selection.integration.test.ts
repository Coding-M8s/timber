import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, withRepository } from "./helpers/git";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test.each([
  ["Ctrl-C", "menu", "\u0003"],
  ["Ctrl-C", "expansion confirmation", "\u0003"],
  ["Escape then Enter", "menu", "\u001b\n"],
] as const)(
  "%s at the %s cancels successfully in a real terminal without changing Git or files",
  async (_key, stage, input) => {
    await withRepository(async primary => {
      for (let index = 1; index <= 10; index++) await git(primary, "branch", `TIM-42-${index}`);
      const tracked = join(primary, "tracked.txt");
      await writeFile(tracked, "dirty work\n");
      const refs = await git(primary, "show-ref");
      const trees = await git(primary, "worktree", "list", "--porcelain");
      let screen = "";
      let expanded = false;
      let interrupted = false;
      const child = Bun.spawn([process.execPath, "--no-env-file", entry, "open", "TIM-42"], {
        cwd: primary,
        env: { ...process.env, CI: "false" },
        timeout: 30_000,
        terminal: {
          data(terminal, data) {
            screen += Buffer.from(data).toString("utf8");
            if (interrupted || !screen.includes("q to cancel: ")) return;
            if (stage === "expansion confirmation") {
              if (!expanded) {
                expanded = true;
                terminal.write("a\n");
              }
              if (!screen.includes("Continue? [y/N] ")) return;
            }
            interrupted = true;
            terminal.write(input);
          },
        },
      });
      try {
        expect(await child.exited).toBe(0);
        expect(interrupted).toBe(true);
        expect(screen).toContain("Cancelled.");
        const entries = screen.split(/\r?\n/u).filter(line => /^ *(?:\d+|[aq])\) /u.test(line));
        expect(entries).toHaveLength(7);
        expect(entries[5]).toBe(" a) Show all 10 matches");
        expect(entries[6]).toBe(" q) Cancel");
        for (const line of entries) expect(line.indexOf(") ") + 2).toBe(4);
        expect(await git(primary, "show-ref")).toBe(refs);
        expect(await git(primary, "worktree", "list", "--porcelain")).toBe(trees);
        expect(await readFile(tracked, "utf8")).toBe("dirty work\n");
      } finally {
        child.kill();
        child.terminal?.close();
      }
    });
  },
);
