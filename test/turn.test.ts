// One test per rule id in docs/turn-rules.md. The first word of each test
// name is the rule id; scripts/check-rules.mjs depends on that.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Obligation, PrFacts, ReviewFact, ThreadFact } from "../shared/model.ts";
import { deriveLocal, deriveTurn, sectionOf, type TurnContext } from "../server/turn.ts";

const ME = "jmfieldman";
const NOW = new Date("2026-10-12T12:00:00Z");
const ctx: TurnContext = { me: ME, now: NOW, botLogins: new Set(["review-agent"]) };
const HEAD = "head000";

function pr(overrides: Partial<PrFacts> = {}): PrFacts {
  return {
    id: "PR_1",
    number: 1,
    title: "Test PR",
    url: "https://github.com/o/r/pull/1",
    state: "OPEN",
    isDraft: false,
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-11T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    headRefOid: HEAD,
    author: { login: ME, isBot: false, avatarUrl: null },
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    isInMergeQueue: false,
    autoMergeEnabledAt: null,
    reviewRequests: [{ kind: "user", login: "alice" }],
    reviewRequestedAt: { alice: "2026-10-12T10:00:00Z" },
    readyForReviewAt: null,
    lastForcePushAt: null,
    latestReviews: [],
    threads: [],
    conversation: [],
    checks: { rollup: "SUCCESS", headCommittedDate: "2026-10-11T00:00:00Z", newestFailureAt: null, newestCompletedAt: "2026-10-11T00:10:00Z" },
    dismissesStaleReviews: false,
    ...overrides,
  };
}

const theirs = (overrides: Partial<PrFacts> = {}) => pr({ author: { login: "alice", isBot: false, avatarUrl: null }, reviewRequests: [], reviewRequestedAt: {}, ...overrides });

function review(author: string, state: ReviewFact["state"], submittedAt: string, commitOid: string | null = HEAD): ReviewFact {
  return { author, isBot: false, state, submittedAt, commitOid };
}

function thread(...comments: Array<[string, string, boolean?]>): ThreadFact {
  return { isResolved: false, url: "https://github.com/o/r/pull/1#t", comments: comments.map(([author, createdAt, isBot]) => ({ author, createdAt, isBot: Boolean(isBot) })) };
}

function reasons(facts: PrFacts): Obligation[] {
  return deriveTurn(facts, ctx).obligations;
}

function find(facts: PrFacts, reason: string): Obligation | undefined {
  return reasons(facts).find((o) => o.reason === reason);
}

// ---- no PR -----------------------------------------------------------------

test("pushed_no_pr: the remote branch exists and wins over local work", () => {
  assert.equal(deriveLocal({ remoteBranchExists: true, isDirty: true, ahead: 3 }), "pushed_no_pr");
});

test("local_work: dirty or ahead", () => {
  assert.equal(deriveLocal({ remoteBranchExists: false, isDirty: true, ahead: 0 }), "local_work");
  assert.equal(deriveLocal({ remoteBranchExists: false, isDirty: false, ahead: 2 }), "local_work");
});

test("local_empty: nothing else matches", () => {
  assert.equal(deriveLocal({ remoteBranchExists: false, isDirty: false, ahead: 0 }), "local_empty");
});

// ---- my PRs ----------------------------------------------------------------

test("closed (mine): a merged PR is nobody's turn and skips the other rows", () => {
  const result = deriveTurn(pr({ state: "MERGED", mergedAt: "2026-10-12T00:00:00Z", checks: { ...pr().checks, rollup: "FAILURE" } }), ctx);
  assert.equal(result.headline, "nobody");
  assert.deepEqual(result.obligations.map((o) => o.reason), ["closed"]);
});

test("draft (mine): my draft is my turn", () => {
  assert.equal(find(pr({ isDraft: true }), "draft")?.holder, "me");
});

test("conflict: a conflicting PR is my turn", () => {
  assert.equal(find(pr({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), "conflict")?.holder, "me");
});

test("ci_failed: failed checks are my turn, since the newest failure", () => {
  const o = find(pr({ checks: { ...pr().checks, rollup: "FAILURE", newestFailureAt: "2026-10-12T09:00:00Z" } }), "ci_failed");
  assert.equal(o?.holder, "me");
  assert.equal(o?.since, "2026-10-12T09:00:00Z");
});

test("changes_requested: a change request newer than my last push is my turn", () => {
  assert.equal(find(pr({ latestReviews: [review("alice", "CHANGES_REQUESTED", "2026-10-12T08:00:00Z")] }), "changes_requested")?.holder, "me");
  assert.equal(find(pr({ latestReviews: [review("alice", "CHANGES_REQUESTED", "2026-10-10T08:00:00Z")] }), "changes_requested"), undefined);
});

test("thread_reply (mine): a person's last comment on an open thread is my turn", () => {
  const facts = pr({ threads: [thread([ME, "2026-10-12T01:00:00Z"], ["alice", "2026-10-12T02:00:00Z"])] });
  assert.equal(find(facts, "thread_reply")?.holder, "me");
});

test("bot_finding: a bot's last comment is my turn with its own reason", () => {
  const byType = pr({ threads: [thread(["cursor", "2026-10-12T02:00:00Z", true])] });
  const byLogin = pr({ threads: [thread(["review-agent", "2026-10-12T02:00:00Z"])] });
  const bySuffix = pr({ threads: [thread(["devin[bot]", "2026-10-12T02:00:00Z"])] });
  const byDashSuffix = pr({ threads: [thread(["helper-bot", "2026-10-12T02:00:00Z"])] });
  for (const facts of [byType, byLogin, bySuffix, byDashSuffix]) {
    assert.equal(find(facts, "bot_finding")?.holder, "me");
    assert.equal(find(facts, "thread_reply"), undefined);
  }
});

test("ready_to_merge: approved, green and clean is my turn", () => {
  const facts = pr({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", reviewRequests: [], latestReviews: [review("alice", "APPROVED", "2026-10-12T05:00:00Z")] });
  assert.equal(find(facts, "ready_to_merge")?.holder, "me");
  assert.equal(find({ ...facts, autoMergeEnabledAt: "2026-10-12T06:00:00Z" }, "ready_to_merge"), undefined);
});

test("stale_approval: with dismiss-stale on, an approval of an old head waits on the approver", () => {
  const facts = pr({
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    reviewRequests: [],
    dismissesStaleReviews: true,
    latestReviews: [review("alice", "APPROVED", "2026-10-11T05:00:00Z", "old111")],
  });
  assert.deepEqual(find(facts, "stale_approval")?.who, ["alice"]);
  assert.equal(find(facts, "ready_to_merge"), undefined);
  // With dismiss-stale off, the approval stands (D1).
  assert.equal(find({ ...facts, dismissesStaleReviews: false }, "ready_to_merge")?.holder, "me");
});

test("request_review: a ready PR with no reviewer is my turn", () => {
  assert.equal(find(pr({ reviewRequests: [], reviewRequestedAt: {} }), "request_review")?.holder, "me");
  assert.equal(find(pr({ reviewRequests: [], isDraft: true }), "request_review"), undefined);
});

test("review_requested (mine): a pending request waits on the reviewer", () => {
  const o = find(pr(), "review_requested");
  assert.equal(o?.holder, "others");
  assert.deepEqual(o?.who, ["alice"]);
  assert.equal(o?.since, "2026-10-12T10:00:00Z");
});

test("rereview: after I push past a change request, it waits on that reviewer (D2)", () => {
  const facts = pr({
    reviewRequests: [],
    latestReviews: [review("alice", "CHANGES_REQUESTED", "2026-10-10T08:00:00Z", "old111")],
  });
  assert.deepEqual(find(facts, "rereview")?.who, ["alice"]);
});

test("awaiting_reply: my last comment on an open thread waits on the others in it", () => {
  const facts = pr({ threads: [thread(["alice", "2026-10-12T01:00:00Z"], [ME, "2026-10-12T02:00:00Z"])] });
  const o = find(facts, "awaiting_reply");
  assert.equal(o?.holder, "others");
  assert.deepEqual(o?.who, ["alice"]);
});

test("ci_running: pending checks are the machine's turn", () => {
  assert.equal(find(pr({ checks: { ...pr().checks, rollup: "PENDING" } }), "ci_running")?.holder, "machine");
});

test("merging: auto-merge or the merge queue is the machine's turn", () => {
  assert.equal(find(pr({ isInMergeQueue: true }), "merging")?.holder, "machine");
});

test("mergeable_unknown: an unknown merge state is the machine's turn", () => {
  assert.equal(find(pr({ mergeable: "UNKNOWN" }), "mergeable_unknown")?.holder, "machine");
});

function comment(author: string, createdAt: string, mentions: string[] = [], isBot = false) {
  return { author, isBot, createdAt, mentions };
}

test("conversation_reply (mine): a person's top-level comment after my last move is my turn", () => {
  const facts = pr({ conversation: [comment(ME, "2026-10-11T01:00:00Z"), comment("alice", "2026-10-12T02:00:00Z")] });
  assert.equal(find(facts, "conversation_reply")?.holder, "me");
  // My later comment answers it.
  assert.equal(find({ ...facts, conversation: [...facts.conversation, comment(ME, "2026-10-12T03:00:00Z")] }, "conversation_reply"), undefined);
  // Bots do not count.
  assert.equal(find(pr({ conversation: [comment("cursor", "2026-10-12T02:00:00Z", [], true)] }), "conversation_reply"), undefined);
});

// ---- their PRs -------------------------------------------------------------

test("closed (theirs): a closed PR is nobody's turn", () => {
  assert.equal(deriveTurn(theirs({ state: "CLOSED", closedAt: "2026-10-12T00:00:00Z" }), ctx).headline, "nobody");
});

test("review_requested (theirs): a request for me by name is my turn", () => {
  const facts = theirs({ reviewRequests: [{ kind: "user", login: ME }], reviewRequestedAt: { [ME]: "2026-10-12T09:00:00Z" } });
  const result = deriveTurn(facts, ctx);
  assert.equal(result.headline, "me");
  assert.equal(sectionOf(true, false, result.headline), "review");
});

test("team_review_requested: a team request waits on the team (D3)", () => {
  const facts = theirs({ reviewRequests: [{ kind: "team", login: "@acme/mobile" }] });
  const o = find(facts, "team_review_requested");
  assert.equal(o?.holder, "others");
  assert.deepEqual(o?.who, ["@acme/mobile"]);
});

test("thread_reply (theirs): a reply in a thread I commented in is my turn", () => {
  const facts = theirs({ threads: [thread([ME, "2026-10-12T01:00:00Z"], ["alice", "2026-10-12T02:00:00Z"])] });
  assert.equal(find(facts, "thread_reply")?.holder, "me");
  // A thread I never commented in is not mine to answer.
  assert.equal(find(theirs({ threads: [thread(["bob", "2026-10-12T01:00:00Z"])] }), "thread_reply"), undefined);
});

test("conversation_reply (theirs): the author's reply after my comment is my turn, even on a draft", () => {
  // The shape that motivated this rule: my review, my comment, then the author's reply, on a draft.
  const facts = theirs({
    isDraft: true,
    latestReviews: [review(ME, "COMMENTED", "2026-10-06T00:41:24Z", "old111")],
    conversation: [comment(ME, "2026-10-07T15:00:35Z"), comment("alice", "2026-10-07T17:58:11Z", [ME])],
  });
  assert.equal(find(facts, "conversation_reply")?.holder, "me");
  const result = deriveTurn(facts, ctx);
  assert.equal(result.headline, "me");
  assert.equal(sectionOf(true, false, result.headline), "review");
  // A PR I never touched: someone else's comment is not my turn unless it mentions me.
  assert.equal(find(theirs({ conversation: [comment("bob", "2026-10-12T02:00:00Z")] }), "conversation_reply"), undefined);
  assert.equal(find(theirs({ conversation: [comment("bob", "2026-10-12T02:00:00Z", [ME])] }), "conversation_reply")?.holder, "me");
});

test("new_commits: commits after my review, with no re-request, are my turn (D6)", () => {
  const facts = theirs({ latestReviews: [review(ME, "COMMENTED", "2026-10-10T08:00:00Z", "old111")] });
  assert.equal(find(facts, "new_commits")?.holder, "me");
  assert.equal(deriveTurn(facts, ctx).headline, "me");
});

test("awaiting_fixes: my change request with no push since waits on the author", () => {
  const facts = theirs({ latestReviews: [review(ME, "CHANGES_REQUESTED", "2026-10-12T08:00:00Z")] });
  assert.equal(find(facts, "awaiting_fixes")?.holder, "others");
});

test("author_to_merge: my approval of the head waits on the author", () => {
  const facts = theirs({ latestReviews: [review(ME, "APPROVED", "2026-10-12T08:00:00Z")] });
  assert.equal(find(facts, "author_to_merge")?.holder, "others");
});

test("draft (theirs): their draft waits on them", () => {
  assert.equal(find(theirs({ isDraft: true }), "draft")?.holder, "others");
});

test("watching: with no other row, it waits on the author", () => {
  const result = deriveTurn(theirs(), ctx);
  assert.deepEqual(result.obligations.map((o) => o.reason), ["watching"]);
  assert.equal(sectionOf(true, false, result.headline), "waiting");
});

// ---- overlay ---------------------------------------------------------------

test("nudge: a review request older than 24 hours adds my nudge (D5)", () => {
  const facts = pr({ reviewRequestedAt: { alice: "2026-10-11T06:00:00Z" } });
  const nudge = find(facts, "nudge");
  assert.equal(nudge?.holder, "me");
  assert.deepEqual(nudge?.who, ["alice"]);
  assert.equal(nudge?.since, "2026-10-12T06:00:00.000Z");
  // The original obligation stays.
  assert.equal(find(facts, "review_requested")?.holder, "others");
  // Machine obligations never nudge.
  assert.equal(find(pr({ reviewRequests: [], checks: { ...pr().checks, rollup: "PENDING", headCommittedDate: "2026-10-01T00:00:00Z" } }), "nudge"), undefined);
});

// ---- sections --------------------------------------------------------------

test("sectionOf maps headline and owner to a sidebar section", () => {
  assert.equal(sectionOf(false, true, null), "local");
  assert.equal(sectionOf(true, true, "me"), "code");
  assert.equal(sectionOf(true, false, "me"), "review");
  assert.equal(sectionOf(true, true, "machine"), "waiting");
  assert.equal(sectionOf(true, false, "nobody"), "done");
});
