# Multiple Linear and Jira credentials

Timber can save several Linear personal API keys and several Jira email/token
pairs, and select one per repository. With a single saved entry nothing changes:
that entry is the default for every repository.

Secrets and selections both live in Timber's private credential store, never in
`.timber.toml`, the global `config.toml`, logs or diagnostics:

- `${XDG_CONFIG_HOME:-$HOME/.config}/timber/credentials/linear.json`
- `${XDG_CONFIG_HOME:-$HOME/.config}/timber/credentials/jira.json`

The same storage protections apply as for a single entry: plaintext, owner-only
files outside every Git worktree, with locked, atomic publication on Save.

## Entries and labels

Each saved entry has a short, non-secret label, such as `acme` or `personal`, so
you can tell workspaces and accounts apart without revealing a key. The first entry
is named `default` automatically. Setup asks for a label when you add another one.
Labels use 1-32 lowercase letters, digits, hyphens or underscores.

Jira entries belong to one normalized site URL and token mode (unscoped, or scoped
to a cloud ID). Two logins for the same site and mode need different labels; a
different site or mode keeps its own independent entries. Jira menus show each
entry's label and Atlassian email, never its token.

## Repository selection

A repository is identified by its shared Git directory. The primary checkout and
all of its linked worktrees therefore share one selection, wherever you run setup.
A separate clone is a different repository, and moving a checkout's `.git`
directory needs a new selection. Remote names and URLs are not used.

At lookup time Timber resolves credentials in this order:

1. An explicit environment override, unchanged from single-entry behavior:
   `LINEAR_API_KEY`, or a complete `JIRA_EMAIL` and `JIRA_API_TOKEN` pair. Blank,
   invalid or partial overrides fail without falling back to saved entries.
2. The entry this repository selected.
3. The only saved entry, when exactly one exists (for Jira: for that site and mode).

With several saved entries and no selection for the repository, Timber stops
before any request or Git change and asks you to run `timber setup` in that
repository. It never tries entries in turn.

## Adding a second entry

Choose "Add another" in the Linear or Jira login menu of `timber setup`. In
repository setup, Timber then asks whether this repository should use the new
entry. Answering no keeps this repository on its previous entry.

Other repositories that relied on the former single entry without a selection
now report that none is selected. Run `timber setup` in each one and pick an entry.
Machine-default setup (`timber setup --global`) can add, replace and remove
entries but does not select one for any repository.

## Changing and removing entries

Repository setup can switch this repository to another entry, replace an entry's
secret, or stop selecting an entry while keeping it saved for other repositories.

Removing an entry deletes it for every repository. When other repositories
selected it, setup says how many and asks for confirmation first; their selections
are cleared. When only one entry remains, it becomes the default for every
repository again.

All changes are drafts until Save. Cancelling or a failed save restores the
previous credentials and selections.

## Compatibility

A store holding only a single `default` entry and no selections keeps the original
single-entry file format, so older Timber releases can still read it. Adding a
labeled entry or a repository selection writes a newer format that older
releases refuse with a storage error rather than guessing.
