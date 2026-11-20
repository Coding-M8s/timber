import { expect, test } from "bun:test";
import { decideNewBranchCollision, type NewBranchInspection, type RemoteCollision } from "../src/git/new-collision";

const a = "a".repeat(40);
const b = "b".repeat(40);
const remote = (name: string, cached: string | null, live: RemoteCollision["live"], selectorSafe = true): RemoteCollision =>
  ({ remote: name, cached, live, selectorSafe });
const inspect = (...remotes: RemoteCollision[]): NewBranchInspection => ({ name: "feature/x", local: null, remotes });

test("creates when there are no remotes or every remote is verified missing with no cached ref", () => {
  expect(decideNewBranchCollision(inspect(), { interactive: false })).toEqual({ kind: "create" });
  expect(decideNewBranchCollision(inspect(remote("origin", null, { kind: "missing" })), { interactive: true, explicitBase: "x" }))
    .toEqual({ kind: "create" });
});

test("local branch refuses with open guidance, naming the worktree path when checked out", () => {
  const plain = decideNewBranchCollision({ name: "feature/x", local: { commit: a, checkedOutAt: null }, remotes: [] }, { interactive: true });
  expect(plain).toMatchObject({ kind: "refuse" });
  expect((plain as { message: string }).message).toContain("timber open -- 'feature/x'");
  const checked = decideNewBranchCollision({ name: "feature/x", local: { commit: a, checkedOutAt: "/w/it's" }, remotes: [] }, { interactive: true });
  expect((checked as { message: string }).message).toContain("is already checked out at /w/it's");
  expect((checked as { message: string }).message).toContain("timber open -- '/w/it'\\''s'");
});

test("single live match offers open interactively and refuses otherwise", () => {
  const state = inspect(remote("origin", a, { kind: "present", commit: a }));
  const offer = decideNewBranchCollision(state, { interactive: true });
  expect(offer).toEqual({
    kind: "offer-open",
    matches: [{ remote: "origin", commit: a, selector: "origin/feature/x" }],
    prompt: "Branch already exists on origin. Did you mean timber open?",
  });
  const refused = decideNewBranchCollision(state, { interactive: false });
  expect((refused as { message: string }).message).toContain("timber open -- 'origin/feature/x'");
});

test("disagreement lines show twelve-character commits or missing", () => {
  const offer = decideNewBranchCollision(inspect(remote("origin", b, { kind: "present", commit: a })), { interactive: true });
  expect((offer as { prompt: string }).prompt).toContain(`Cached origin/feature/x: ${b.slice(0, 12)}; live: ${a.slice(0, 12)}`);
  const uncached = decideNewBranchCollision(inspect(remote("origin", null, { kind: "present", commit: a })), { interactive: true });
  expect((uncached as { prompt: string }).prompt).toContain("Cached origin/feature/x: missing;");
});

test("stale tracking ref and unknown state refuse and unknown is never called absent", () => {
  const stale = decideNewBranchCollision(inspect(remote("origin", a, { kind: "missing" })), { interactive: true });
  expect((stale as { message: string }).message).toContain(`is at ${a.slice(0, 12)}, but the branch is missing on origin`);
  const unknown = decideNewBranchCollision(inspect(remote("origin", null, { kind: "unknown", reason: "x" })), { interactive: true });
  expect((unknown as { message: string }).message).toContain("its state is unknown");
  expect((unknown as { message: string }).message).not.toMatch(/does not exist|absent/u);
});

test("unknown on one remote refuses even when another remote has the branch", () => {
  const mixed = decideNewBranchCollision(inspect(
    remote("origin", null, { kind: "present", commit: a }), remote("backup", null, { kind: "unknown", reason: "x" }),
  ), { interactive: true });
  expect(mixed.kind).toBe("refuse");
  expect((mixed as { message: string }).message).toContain("timber open -- 'origin/feature/x'");
});

test("two matches offer both explicitly and refuse noninteractively listing each command", () => {
  const state = inspect(remote("origin", a, { kind: "present", commit: a }), remote("up", null, { kind: "present", commit: b }));
  const offer = decideNewBranchCollision(state, { interactive: true });
  expect((offer as { matches: readonly unknown[] }).matches).toHaveLength(2);
  const refused = decideNewBranchCollision(state, { interactive: false });
  expect((refused as { message: string }).message).toContain("Choose one remote explicitly");
  expect((refused as { message: string }).message).toContain("timber open -- 'up/feature/x'");
});

test("explicit base and unsafe selectors refuse without an offer", () => {
  const state = inspect(remote("origin", a, { kind: "present", commit: a }));
  const withBase = decideNewBranchCollision(state, { interactive: true, explicitBase: "main" });
  expect((withBase as { message: string }).message).toContain("--base main cannot be applied: branch feature/x already exists on origin.");
  const unsafe = decideNewBranchCollision(inspect(remote("origin", a, { kind: "present", commit: a }, false)), { interactive: true });
  expect(unsafe.kind).toBe("refuse");
});
