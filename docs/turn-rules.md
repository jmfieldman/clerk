# Turn rules

Status: ACCEPTED 2026-10-12. Rows marked **(D1)**–**(D6)** follow a decision in [Decisions](#decisions).

This file is the source of truth for turn behavior. To change behavior, change this file first, then the code. See `AGENTS.md`.

Clerk gives each workspace a turn. The rules below are deterministic: the same PR snapshot always gives the same turn. Clerk evaluates them in the daemon after each batch fetch.

## Model

Each rule that matches adds one obligation. A PR can have more than one obligation at the same time.

```ts
type Holder = "me" | "others" | "machine" | "nobody";

interface Obligation {
  holder: Holder;
  who: string[];   // GitHub logins, or "@org/team" for a team
  reason: Reason;  // the rule id below, for example "ci_failed"
  since: string;   // ISO time when the obligation started
  ref?: string;    // URL of the thread, review, or check
}
```

The headline holder is the highest-priority holder in the obligation list: `me` > `others` > `machine` > `nobody`. The sidebar section comes from the headline holder and the owner axis.

| Headline | Owner | Section |
|---|---|---|
| `me` | mine | Your move · code |
| `me` | theirs | Your move · review |
| `others` or `machine` | either | Waiting |
| `nobody` | either | Done |
| no PR | — | Not a PR yet |

## Inputs

- `me`: the `viewer { login }` from the batch query, unless the Clerk setting "GitHub username" is set. The setting wins.
- `isMine`: `pr.author.login == me`.
- `lastPush`: the later of the head commit `committedDate` and the newest `HeadRefForcePushedEvent.createdAt`. This is an approximation. GitHub does not expose a reliable push time.
- `bot`: a GitHub Bot account, a login that ends in `[bot]` or `-bot`, or a login in the Clerk setting "Bot logins". The `-bot` suffix covers agents that post through a user account, for example `helper-bot`.

## Workspaces with no PR

Clerk puts these in "Not a PR yet". Clerk reads `gitRuntime` from Paseo and makes no GitHub call.

| Rule | Condition | Sub-label |
|---|---|---|
| `pushed_no_pr` | the branch exists on the remote, and no PR has this head branch | pushed, no PR |
| `local_work` | `isDirty`, or `aheadOfOrigin > 0` | local work |
| `local_empty` | no other row matches | no changes |

The first row that matches wins.

## My PRs (`isMine`)

If `closed` matches, Clerk skips the other rows. Otherwise Clerk evaluates every row, and each row that matches adds an obligation.

| Rule | Condition | Holder | Who | Since |
|---|---|---|---|---|
| `closed` | `state` is `MERGED` or `CLOSED` | `nobody` | — | `mergedAt` or `closedAt` |
| `draft` | `isDraft` | `me` | me | `createdAt` |
| `conflict` | `mergeable == CONFLICTING`, or `mergeStateStatus == DIRTY` | `me` | me | `updatedAt` |
| `ci_failed` | check rollup is `FAILURE` or `ERROR` | `me` | me | newest failed check `completedAt` |
| `changes_requested` | a reviewer's latest review is `CHANGES_REQUESTED`, and the review is newer than `lastPush` | `me` | me | review `submittedAt` |
| `thread_reply` | an unresolved thread has a last comment from a person who is not `me` and not a `bot` | `me` | me | that comment `createdAt` |
| `conversation_reply` | the newest conversation comment (top-level, not a review thread) from a person who is not `me` and not a `bot` is newer than my last comment or review | `me` | me | that comment `createdAt` |
| `bot_finding` **(D4)** | an unresolved thread has a last comment from a `bot` | `me` | me | that comment `createdAt` |
| `ready_to_merge` | `reviewDecision == APPROVED`, checks are `SUCCESS`, `mergeStateStatus == CLEAN`, and no auto-merge or merge queue | `me` | me | the later of the approval and the last check |
| `stale_approval` **(D1)** | `reviewDecision == APPROVED`, the approving review commit is not the head commit, and the repo dismisses stale approvals | `others` | the approvers | `lastPush` |
| `request_review` | not a draft, no pending review requests, no approval, and no `CHANGES_REQUESTED` review | `me` | me | the later of `createdAt` and the ready-for-review event |
| `review_requested` | a user or team is in `reviewRequests` | `others` | each requested reviewer | that `ReviewRequestedEvent.createdAt` |
| `rereview` **(D2)** | a reviewer's latest review is `CHANGES_REQUESTED`, and `lastPush` is newer than the review | `others` | that reviewer | `lastPush` |
| `awaiting_reply` | an unresolved thread has a last comment from `me` | `others` | the other people in the thread | that comment `createdAt` |
| `ci_running` | check rollup is `PENDING` or `EXPECTED` | `machine` | — | `lastPush` |
| `merging` | auto-merge is on, or the PR is in the merge queue | `machine` | — | the auto-merge or queue time |
| `mergeable_unknown` | `mergeable == UNKNOWN` | `machine` | — | `updatedAt` |

## Other people's PRs (`!isMine`)

If `closed` matches, Clerk skips the other rows. `watching` applies only when no other row matches.

| Rule | Condition | Holder | Who | Since |
|---|---|---|---|---|
| `closed` | `state` is `MERGED` or `CLOSED` | `nobody` | — | `mergedAt` or `closedAt` |
| `review_requested` | `me` is in `reviewRequests` as a user | `me` | me | `ReviewRequestedEvent.createdAt` |
| `team_review_requested` **(D3)** | a team is in `reviewRequests`, and `me` is not in `reviewRequests` as a user | `others` | `@org/team` | `ReviewRequestedEvent.createdAt` |
| `thread_reply` | an unresolved thread that `me` commented in has a last comment from a person who is not `me` and not a `bot` | `me` | me | that comment `createdAt` |
| `conversation_reply` | `me` reviewed, commented, or is @-mentioned in the newest conversation comment, and the newest conversation comment from a person who is not `me` and not a `bot` is newer than my last comment or review | `me` | me | that comment `createdAt` |
| `new_commits` **(D6)** | `me` reviewed, `lastPush` is newer than my latest review, and `me` is not in `reviewRequests` | `me` | me | `lastPush` |
| `awaiting_fixes` | my latest review is `CHANGES_REQUESTED`, and `lastPush` is older than the review | `others` | author | my review `submittedAt` |
| `author_to_merge` | my latest review is `APPROVED` on the head commit | `others` | author | my review `submittedAt` |
| `draft` | `isDraft` | `others` | author | `createdAt` |
| `watching` | no other row matches | `others` | author | `updatedAt` |

## Overlay: nudge (D5)

| Rule | Condition | Holder | Who | Since |
|---|---|---|---|---|
| `nudge` | an `others` obligation with reason `review_requested` or `awaiting_reply` is older than 24 hours | `me` | the same `who` | the original `since` plus 24 hours |

The original `others` obligation stays in the list. `machine` obligations never become a nudge.

## Decisions

Accepted by Jason on 2026-10-12. D6 changed and `conversation_reply` added on 2026-10-12, after a PR showed that review threads alone miss top-level replies. To change a decision, edit its row and the rule rows that cite it.

| Id | Question | Decision |
|---|---|---|
| D1 | After an approval, I push new commits. Whose turn is it? | If the repo dismisses stale approvals, `others` (the approvers, rule `stale_approval`). If it does not, the approval stands and `ready_to_merge` applies. Clerk reads the branch protection setting once per repo and caches it. |
| D2 | A reviewer requested changes, and I pushed. I did not re-request a review. Whose turn is it? | `others` (that reviewer). The push is the answer. A re-request is a courtesy. |
| D3 | A team that includes me is requested. Is it my turn? | `others` (`@team`). A team request is a shared queue, not a personal ask. Show it in Waiting with the team name. |
| D4 | A bot (for example Cursor Bugbot or Devin) leaves an unresolved thread on my PR. Is it my turn? | `me`, but with its own reason `bot_finding`, so the row can show it with less weight than a person. |
| D5 | When does a Waiting obligation become a nudge? | 24 hours for `review_requested` and `awaiting_reply`. No nudge for `machine`. |
| D6 | Someone pushed after my review, and I was not re-requested. Is it my turn? | `me`. A push after my review is the author's move, with or without a re-request. Changed from `others` on 2026-10-12 because authors rarely re-request. |

## Fields the batch query must add

Add `defaultBranchRef { branchProtectionRule { dismissesStaleReviews } }` for D1.


The first test query (the batch query from 2026-10-12) does not have these fields:

- `viewer { login }`
- `author { login avatarUrl }`
- `mergedAt closedAt createdAt`
- `autoMergeRequest { enabledAt }`, `isInMergeQueue`
- `timelineItems(last: 30, itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT, HEAD_REF_FORCE_PUSHED_EVENT])` with `createdAt` and the requested reviewer
- `reviewThreads { comments(first: 1) { author } }` to find the thread starter, in addition to the last comment
- `commits(last: 1) { commit { committedDate statusCheckRollup { contexts(last: 50) { ... on CheckRun { conclusion completedAt } } } } }`
