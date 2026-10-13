# clerk

Clerk is a [Paseo](https://paseo.sh) plugin. It adds a section to the top of the Paseo sidebar that shows every open workspace and whose turn it is to act on it.

A docket tracks the work in one workspace. Clerk keeps the list of all workspaces: which PRs wait on you, which wait on someone else, and which are done.

## What Clerk shows

Clerk sorts workspaces into five sections. Inside each section, Clerk groups the rows by Paseo project.

| Section | Contents |
|---|---|
| Your move · code | Your PRs that need you: CI failed, a conflict, requested changes, a reply, ready to merge |
| Your move · review | Other people's PRs that need you: a review request, a reply, new commits after your review |
| Waiting | PRs that wait on another person, or on CI and the merge queue |
| Not a PR yet | Workspaces with no PR: no changes, local work, or a pushed branch with no PR |
| Done | Merged or closed PRs whose workspace is still open |

Each row shows:

- the author avatar
- the branch name
- the age of the oldest open item; the age is amber when the item has been your move for more than 2 days
- the PR number, as a link to GitHub, and the PR title
- up to two badges, with the most urgent badge first

The badge color shows the meaning:

| Color | Meaning | Examples |
|---|---|---|
| Red | Blocks you | `CI failed`, `conflict`, `changes requested` |
| Amber | A person needs a response | `reply to thread`, `new reply`, `nudge` |
| Green | Good news | `ready to merge`, `approved`, `merged` |
| Accent | Someone asks you | `review requested` |
| Gray | Waiting or information | `draft`, `CI running`, `watching` |

Click a row to open its workspace. Click the PR number to open the PR in your browser. In Done rows, use **archive** to archive the workspace.

## Turns

A PR can have more than one open item at the same time. For example, CI can fail on your PR while a reviewer still has to review it. Clerk adds one item for each rule that matches, and shows the most urgent holder:

1. `me`: you must act.
2. `others`: a named person must act.
3. `machine`: CI, auto-merge, or the merge queue must finish.
4. `nobody`: the PR is merged or closed.

The rules are in [`docs/turn-rules.md`](docs/turn-rules.md). That file is the source of truth for turn behavior. To change a rule, edit the document first, then the code. [`AGENTS.md`](AGENTS.md) gives the procedure for coding agents.

## Requirements

- Paseo 0.11.2 or later, with plugins on (`"pluginsEnabled": true` in `~/.paseo/config.json`)
- [GitHub CLI](https://cli.github.com) (`gh`), signed in with `gh auth login`
- `git`

Clerk reads GitHub through `gh` on the machine that runs the Paseo daemon. It uses your `gh` account to find your GitHub login.

## Install

Install from GitHub:

```bash
paseo plugin install https://github.com/jmfieldman/clerk
```

To install a local clone, run the install command on the directory:

```bash
paseo plugin install ~/Development/clerk
```

If Clerk does not show in the sidebar, open Paseo **Settings → Sidebar** and make sure that **Clerk** is not hidden.

## Settings

Open Paseo **Settings → Clerk**.

| Setting | Effect |
|---|---|
| GitHub username | Overrides the login from `gh`. Leave it empty to use the `gh` account. |
| Bot logins | Comments from these logins count as bot findings, not replies. GitHub Bot accounts and logins that end in `[bot]` or `-bot` are always bots. |

## How Clerk reads GitHub

Only the daemon side of Clerk calls git and GitHub. The sidebar reads a model that the daemon keeps in memory.

1. Every 15 seconds, the daemon finds the workspaces that are due:

   | Workspace state | Read from GitHub every |
   |---|---|
   | `machine` (CI running, merge queue) | 1 minute |
   | `me` or `others` | 2 minutes |
   | Not a PR yet | 5 minutes |
   | `nobody` (done) | Never again |

2. One small GraphQL query covers all due workspaces. It finds the PR for each branch and a signature of its state.
3. Clerk reads the full PR details only when the signature changed.
4. Clerk writes each workspace's status to `<git-dir>/clerk/status.json`. Other tools and agents can read this file.

A new workspace, an agent turn that ends, and the refresh button in the Clerk header also start a read. If GitHub reports fewer than 500 remaining rate-limit points, Clerk stops automatic reads until the limit resets.

## Development

```bash
npm install
npm run check
paseo plugin reload clerk
paseo plugin logs clerk
```

`npm run check` runs the type check and the tests. It also checks that each rule id is in `docs/turn-rules.md`, in `server/turn.ts`, in `test/turn.test.ts`, and has a label in `client/sidebar.tsx`.

| Path | Contents |
|---|---|
| `index.client.tsx`, `client/` | The sidebar item, the settings screen, and the screen that opens a workspace |
| `index.server.ts`, `server/` | The refresher, the GitHub queries, and the turn rules |
| `shared/` | The data model, RPC contracts, and settings |
| `docs/turn-rules.md` | The turn rules and the decisions behind them |
| `test/` | One test for each turn rule |

## Known limits

- Clerk finds a PR by its head branch name. If the workspace branch name is not the PR branch name, the workspace shows as "Not a PR yet".
- Clerk reads `dismissesStaleReviews` from branch protection on the default branch. Repositories that use rulesets, or tokens that cannot read branch protection, read as "does not dismiss".
- Archive deletes a managed worktree after its last workspace is archived. Clerk warns about uncommitted changes and about commits that are not in the PR head.
