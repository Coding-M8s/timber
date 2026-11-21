# Multiple Linear and Jira credentials

Timber can save several Linear personal API keys and several Jira email/token
pairs, and select one per repository. One saved entry is the default, used by
every repository without its own selection. Adding another entry never changes
what other repositories use.

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
3. The default entry (for Jira: the default for that site and mode).

Timber never tries entries in turn. If the default belongs to a different
workspace or account, the lookup fails like any other credential error; run
`timber setup` in that repository and select the right entry.

## Adding another entry

Choose "Add another" in the Linear or Jira login menu of `timber setup`. In
repository setup, Timber then asks whether this repository should use the new
entry. Answering no leaves this repository on the default.

Every other repository keeps what it used before: its own selection, or the
default. This suits working in many repositories with one main account, such as
open source contributions alongside a work workspace: save the main account first
(it becomes the default) and select the other entry only where it is needed.
Machine-default setup (`timber setup --global`) can add, replace and remove
entries and change the default, but does not select one for any repository.

## The default entry

The first saved entry is the default. Choose "Make ... the default" in setup to
change it; repositories with their own selection are unaffected. To keep a
repository on the current default even if the default changes later, select that
entry explicitly for the repository.

## Changing and removing entries

Repository setup can switch this repository to another entry, replace an entry's
secret, or stop selecting an entry so this repository uses the default again,
while keeping the entry saved for other repositories.

Removing an entry deletes it for every repository. When other repositories
selected it, setup says how many and asks for confirmation first; their selections
are cleared and they use the default. Removing the default makes the next saved
entry the default, and setup says which one.

All changes are drafts until Save. Cancelling or a failed save restores the
previous credentials and selections.

## Compatibility

A store holding only a single `default` entry and no selections keeps the original
single-entry file format, so older Timber releases can still read it. Adding a
labeled entry or a repository selection writes a newer format that older
releases refuse with a storage error rather than guessing.
