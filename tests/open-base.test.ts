import { expect, test } from "bun:test";
import { createOpenHandler } from "../src/commands/open";
import type { CommandContext } from "../src/services";
import type { BaseAssociationRead } from "../src/git/base-metadata";
import type { ChoiceOption } from "../src/selection";
import { createServiceDouble, repositoryFixture, worktreeFixture } from "./helpers/services";

function fixture() {
  const tree = worktreeFixture({ path: "/linked", branch: "feature", isPrimary: false });
  const events: string[] = [];
  let association: BaseAssociationRead = { kind: "unassigned" };
  let choices: readonly ChoiceOption[] = [];
  let stdout = "";
  const services = {
    ...createServiceDouble({
      discoverRepository: async () => repositoryFixture(),
      loadConfig: async () => ({ baseBranch: null, remote: null, worktreeDir: null, editor: null, agent: null }),
      resolveOpenTarget: async () => ({ kind: "found", value: { kind: "worktree", worktree: tree } }),
      readBaseAssociation: async () => association,
      writeBaseAssociation: async (_repo, _tree, ref) => {
        events.push("save"); association = { kind: "assigned", ref };
      },
      resolveBase: async (_repo, _config, ref) => {
        if (ref !== "refs/heads/ABU-100" && ref !== "refs/remotes/origin/master") throw new Error("Missing base");
        return { ref, commit: "b".repeat(40), source: "explicit" };
      },
      launchEditor: async () => { events.push("editor"); return { kind: "skipped" }; },
    }),
    listBranches: async () => [
      { kind: "local" as const, name: "feature", ref: "refs/heads/feature", upstream: null },
      { kind: "local" as const, name: "ABU-100", ref: "refs/heads/ABU-100", upstream: null },
      { kind: "remote" as const, name: "master", remote: "origin", ref: "refs/remotes/origin/master" },
    ],
  };
  const context: CommandContext = {
    cwd: "/repo", interactive: true,
    io: { stdout: text => { stdout += text; }, stderr: () => {} },
    choose: async (_message, available) => {
      choices = available;
      return available.find(choice => choice.default)?.value ?? null;
    },
  };
  return { services, context, tree, events,
    association: () => association, choices: () => choices, stdout: () => stdout,
    assign: (value: BaseAssociationRead) => { association = value; } };
}

test("open offers Not assigned by default and leaves base unset", async () => {
  const f = fixture();
  await createOpenHandler(f.services)("feature", {}, f.context);
  expect(f.choices()[0]).toMatchObject({ label: "Not assigned (default)", default: true });
  expect(f.choices().map(choice => choice.value)).toEqual([
    "unassigned", "refs/heads/ABU-100", "refs/remotes/origin/master",
  ]);
  expect(f.association()).toEqual({ kind: "unassigned" });
  expect(f.events).toEqual(["editor"]);
});

test.each(["refs/heads/ABU-100", "refs/remotes/origin/master"])("open saves selected canonical base %s before launch", async ref => {
  const f = fixture();
  f.context.choose = async () => ref;
  await createOpenHandler(f.services)("feature", {}, f.context);
  expect(f.association()).toEqual({ kind: "assigned", ref });
  expect(f.events).toEqual(["save", "editor"]);
});

test("cancelling base selection stops before worktree creation", async () => {
  const f = fixture();
  f.context.choose = async () => null;
  const services = { ...f.services,
    resolveOpenTarget: async () => ({ kind: "found" as const, value: { kind: "branch" as const,
      branch: { kind: "local" as const, name: "feature", ref: "refs/heads/feature", upstream: null } } }),
  };
  await createOpenHandler(services)("feature", {}, f.context);
  expect(f.stdout()).toBe("Cancelled.\n");
  expect(f.events).toEqual([]);
});

test.each(["assigned", "invalid", "noninteractive", "detached"])("open skips base selection when %s", async kind => {
  const f = fixture();
  if (kind === "assigned") f.assign({ kind: "assigned", ref: "refs/heads/master" });
  if (kind === "invalid") f.assign({ kind: "invalid", reason: "malformed" });
  if (kind === "noninteractive") f.context.interactive = false;
  if (kind === "detached") f.tree.branch = null;
  f.context.choose = async () => { throw new Error("Unexpected prompt"); };
  await createOpenHandler(f.services)("feature", {}, f.context);
  expect(f.events).toEqual(["editor"]);
});

test("open refuses a forged base selection before launch", async () => {
  const f = fixture();
  f.context.choose = async () => "refs/heads/feature";
  await expect(createOpenHandler(f.services)("feature", {}, f.context)).rejects.toThrow("Invalid base selection");
  expect(f.events).toEqual([]);
});

test("open preserves a base assigned while the chooser is open", async () => {
  const f = fixture();
  f.context.choose = async () => {
    f.assign({ kind: "assigned", ref: "refs/heads/master" });
    return "refs/heads/ABU-100";
  };
  await expect(createOpenHandler(f.services)("feature", {}, f.context)).rejects.toThrow("Base association changed");
  expect(f.association()).toEqual({ kind: "assigned", ref: "refs/heads/master" });
  expect(f.events).toEqual([]);
});
