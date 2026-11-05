import { expect, test } from "bun:test";
import { editDefaultTracker, editTrackerConnections } from "../src/setup/trackers";
import { questionnaire } from "../src/setup/questions";
import { runSetupHub, sectionStatus } from "../src/setup/hub";
import type { ConfigFile } from "../src/config";
import type { SetupPrompt, SetupTarget } from "../src/setup/types";
import { repositoryFixture } from "./helpers/services";

const io = { stdout() {}, stderr() {} };
function target(values: ConfigFile = {}): SetupTarget {
  return { scope: "repository", path: "/repo/.timber.toml", file: { path: "/repo/.timber.toml", source: null, values },
    scopes: { global: { path: "/global.toml", source: null, values: { default_tracker: "linear" } }, local: null },
    repository: repositoryFixture(), branches: [], tracked: false, exclude: null };
}
function prompt(answers: string[]): SetupPrompt {
  return { select: async (_message, choices) => {
    const answer = answers.shift(); expect(choices.some(choice => choice.value === answer)).toBe(true); return answer!;
  }, text: async () => { throw new Error("Unexpected text"); }, confirm: async () => false, close() {} };
}

for (const provider of ["github", "linear", "jira"] as const) {
  test(`default ${provider} edits only its connection`, async () => {
    const calls: string[] = []; const file: ConfigFile = { jira: { site_url: "https://example.atlassian.net" } };
    await editDefaultTracker(file, target(file), prompt([provider]), io, {
      github: { edit: async () => { calls.push("github"); } },
      linear: { edit: async () => { calls.push("linear"); }, review() {}, save: async publish => { await publish(); } },
      editJira: async configure => { expect(configure).toBe(true); calls.push("jira"); },
    });
    expect(file.default_tracker).toBe(provider); expect(calls).toEqual([provider]); expect(file.jira).toBeTruthy();
  });
}

test("None and inheritance only change the tracker preference", async () => {
  const file: ConfigFile = { default_tracker: "github", jira: { site_url: "https://example.atlassian.net" } };
  const destination = target(file);
  await editDefaultTracker(file, destination, prompt(["none"]), io, {});
  expect(file).toEqual({ default_tracker: "none", jira: { site_url: "https://example.atlassian.net" } });
  expect(sectionStatus("default_tracker", file, destination)).toBe("None");
  await editDefaultTracker(file, destination, prompt(["inherit"]), io, {});
  expect(file).not.toHaveProperty("default_tracker"); expect(file.jira).toBeTruthy();
  expect(sectionStatus("default_tracker", file, destination)).toContain("Linear");
  expect(sectionStatus("default_tracker", file, destination)).toContain("machine");
});

test("connections can configure every provider without changing the default", async () => {
  const file: ConfigFile = { default_tracker: "none" }; const calls: string[] = [];
  await editTrackerConnections(prompt(["github", "linear", "jira", "back"]), io, {
    github: { edit: async () => { calls.push("github"); } },
    linear: { edit: async () => { calls.push("linear"); }, review() {}, save: async publish => { await publish(); } },
    editJira: async configure => { expect(configure).toBe(false); calls.push("jira"); },
  });
  expect(calls).toEqual(["github", "linear", "jira"]); expect(file).toEqual({ default_tracker: "none" });
});

test("guided step three chooses default and does not ask unrelated connection questions", async () => {
  const questions: string[] = []; const scripted = prompt(["none", "none", "github"]); const select = scripted.select;
  scripted.select = async (message, choices, current) => { questions.push(message); return select(message, choices, current); };
  let github = 0;
  const file = await questionnaire(target({}), scripted, io, async () => true, undefined, { edit: async () => { github++; } });
  expect(questions[2]).toBe("Which issue tracker do you use?"); expect(questions).toHaveLength(3);
  expect(file?.default_tracker).toBe("github"); expect(github).toBe(1);
});

test("hub cancellation retains original tracker and connection settings", async () => {
  const file: ConfigFile = { default_tracker: "github", jira: { site_url: "https://example.atlassian.net" } };
  expect(await runSetupHub(target(file), prompt(["default_tracker", "none", "cancel"]), io, async () => true)).toBeNull();
  expect(file.default_tracker).toBe("github"); expect(file.jira).toBeTruthy();
});
