// The turn rules. docs/turn-rules.md is the source of truth: each rule(<id>)
// here is one row in that document, and test/turn.test.ts has one test per id.
// Pure functions only: no git, no GitHub, no clock except `ctx.now`.
import type { Holder, LocalState, Obligation, PrFacts, Section } from "../shared/model.ts";
import { HOLDER_RANK } from "../shared/model.ts";

export interface TurnContext {
  me: string;
  now: Date;
  /** Extra bot logins from settings, lower case. */
  botLogins: ReadonlySet<string>;
}

export interface TurnResult {
  obligations: Obligation[];
  headline: Holder;
}

type Rule<Input> = { id: string; apply(input: Input): Obligation[] };
type PrInput = { pr: PrFacts; ctx: TurnContext; derived: Derived };

function rule<Input>(id: string, apply: (input: Input) => Obligation[] | Obligation | null): Rule<Input> {
  return {
    id,
    apply(input) {
      const result = apply(input);
      if (!result) return [];
      return Array.isArray(result) ? result : [result];
    },
  };
}

const NUDGE_HOURS = 24;
const NUDGE_REASONS = new Set(["review_requested", "awaiting_reply"]);

// ---- helpers ---------------------------------------------------------------

function time(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : 0;
}

function latest(...isos: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const iso of isos) if (iso && (!best || time(iso) > time(best))) best = iso;
  return best;
}

function oldest(isos: string[]): string {
  return isos.reduce((a, b) => (time(b) < time(a) ? b : a));
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

interface Derived {
  isMe(login: string): boolean;
  isBot(login: string, flagged: boolean): boolean;
  lastPush: string | null;
  meRequested: boolean;
}

function derive(pr: PrFacts, ctx: TurnContext): Derived {
  return {
    isMe: (login) => same(login, ctx.me),
    isBot: (login, flagged) => {
      const lower = login.toLowerCase();
      return flagged || lower.endsWith("[bot]") || lower.endsWith("-bot") || ctx.botLogins.has(lower);
    },
    lastPush: latest(pr.checks.headCommittedDate, pr.lastForcePushAt),
    meRequested: pr.reviewRequests.some((r) => r.kind === "user" && same(r.login, ctx.me)),
  };
}

function ob(holder: Holder, who: string[], reason: string, since: string, ref?: string): Obligation {
  return ref ? { holder, who, reason, since, ref } : { holder, who, reason, since };
}

/** Unresolved threads with their last comment. */
function openThreads(pr: PrFacts) {
  return pr.threads
    .filter((t) => !t.isResolved && t.comments.length > 0)
    .map((t) => ({ thread: t, last: t.comments[t.comments.length - 1] }));
}

/** The newest conversation comment from a person other than me, if it is newer than my last move. */
function conversationReply(pr: PrFacts, ctx: TurnContext, derived: Derived, requireParticipation: boolean): Obligation | null {
  const people = (pr.conversation ?? []).filter((c) => !derived.isBot(c.author, c.isBot));
  const last = [...people].reverse().find((c) => !derived.isMe(c.author));
  if (!last) return null;
  const myMoves = [
    ...people.filter((c) => derived.isMe(c.author)).map((c) => c.createdAt),
    ...pr.latestReviews.filter((r) => derived.isMe(r.author)).map((r) => r.submittedAt),
    ...pr.threads.flatMap((t) => t.comments.filter((c) => derived.isMe(c.author)).map((c) => c.createdAt)),
  ];
  const myLast = latest(...myMoves, derived.isMe(pr.author.login) ? pr.createdAt : null);
  if (myLast && time(last.createdAt) <= time(myLast)) return null;
  if (requireParticipation && !myMoves.length && !last.mentions.includes(ctx.me.toLowerCase())) return null;
  return ob("me", [ctx.me], "conversation_reply", last.createdAt, pr.url);
}

// ---- rules: my PRs ---------------------------------------------------------

const closedRule = rule<PrInput>("closed", ({ pr }) =>
  pr.state === "OPEN" ? null : ob("nobody", [], "closed", pr.mergedAt ?? pr.closedAt ?? pr.updatedAt, pr.url),
);

const staleApprovers = (pr: PrFacts) =>
  pr.latestReviews.filter((r) => r.state === "APPROVED" && r.commitOid !== null && r.commitOid !== pr.headRefOid);

export const MINE_RULES: Rule<PrInput>[] = [
  rule("draft", ({ pr, ctx }) => (pr.isDraft ? ob("me", [ctx.me], "draft", pr.createdAt, pr.url) : null)),
  rule("conflict", ({ pr, ctx }) =>
    pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY" ? ob("me", [ctx.me], "conflict", pr.updatedAt, pr.url) : null,
  ),
  rule("ci_failed", ({ pr, ctx, derived }) =>
    pr.checks.rollup === "FAILURE" || pr.checks.rollup === "ERROR"
      ? ob("me", [ctx.me], "ci_failed", pr.checks.newestFailureAt ?? derived.lastPush ?? pr.updatedAt, pr.url + "/checks")
      : null,
  ),
  rule("changes_requested", ({ pr, ctx, derived }) => {
    const reviews = pr.latestReviews.filter((r) => r.state === "CHANGES_REQUESTED" && time(r.submittedAt) > time(derived.lastPush));
    return reviews.length ? ob("me", [ctx.me], "changes_requested", oldest(reviews.map((r) => r.submittedAt)), pr.url) : null;
  }),
  rule("thread_reply", ({ pr, ctx, derived }) => {
    const hits = openThreads(pr).filter(({ last }) => !derived.isMe(last.author) && !derived.isBot(last.author, last.isBot));
    return hits.length ? ob("me", [ctx.me], "thread_reply", oldest(hits.map((h) => h.last.createdAt)), hits[0].thread.url ?? pr.url) : null;
  }),
  rule("conversation_reply", ({ pr, ctx, derived }) => conversationReply(pr, ctx, derived, false)),
  rule("bot_finding", ({ pr, ctx, derived }) => {
    const hits = openThreads(pr).filter(({ last }) => derived.isBot(last.author, last.isBot));
    return hits.length ? ob("me", [ctx.me], "bot_finding", oldest(hits.map((h) => h.last.createdAt)), hits[0].thread.url ?? pr.url) : null;
  }),
  rule("ready_to_merge", ({ pr, ctx }) => {
    const stale = pr.dismissesStaleReviews && staleApprovers(pr).length > 0;
    const ready =
      pr.reviewDecision === "APPROVED" &&
      pr.checks.rollup === "SUCCESS" &&
      pr.mergeStateStatus === "CLEAN" &&
      !pr.autoMergeEnabledAt &&
      !pr.isInMergeQueue &&
      !stale;
    if (!ready) return null;
    const approvedAt = pr.latestReviews.filter((r) => r.state === "APPROVED").map((r) => r.submittedAt);
    return ob("me", [ctx.me], "ready_to_merge", latest(...approvedAt, pr.checks.newestCompletedAt) ?? pr.updatedAt, pr.url);
  }),
  rule("stale_approval", ({ pr, derived }) => {
    if (pr.reviewDecision !== "APPROVED" || !pr.dismissesStaleReviews) return null;
    const stale = staleApprovers(pr);
    return stale.length ? ob("others", stale.map((r) => r.author), "stale_approval", derived.lastPush ?? pr.updatedAt, pr.url) : null;
  }),
  rule("request_review", ({ pr, ctx }) => {
    const reviewed = pr.latestReviews.some((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED");
    if (pr.isDraft || pr.reviewRequests.length > 0 || reviewed) return null;
    return ob("me", [ctx.me], "request_review", latest(pr.createdAt, pr.readyForReviewAt) ?? pr.createdAt, pr.url);
  }),
  rule("review_requested", ({ pr }) =>
    pr.reviewRequests.map((r) => ob("others", [r.login], "review_requested", pr.reviewRequestedAt[r.login] ?? pr.updatedAt, pr.url)),
  ),
  rule("rereview", ({ pr, derived }) => {
    const requested = new Set(pr.reviewRequests.map((r) => r.login.toLowerCase()));
    return pr.latestReviews
      .filter((r) => r.state === "CHANGES_REQUESTED" && derived.lastPush && time(derived.lastPush) > time(r.submittedAt))
      .filter((r) => !requested.has(r.author.toLowerCase()))
      .map((r) => ob("others", [r.author], "rereview", derived.lastPush ?? pr.updatedAt, pr.url));
  }),
  rule("awaiting_reply", ({ pr, derived }) =>
    openThreads(pr)
      .filter(({ last }) => derived.isMe(last.author))
      .map(({ thread, last }) => {
        const others = [...new Set(thread.comments.map((c) => c.author).filter((a) => !derived.isMe(a)))];
        return ob("others", others, "awaiting_reply", last.createdAt, thread.url ?? pr.url);
      }),
  ),
  rule("ci_running", ({ pr, derived }) =>
    pr.checks.rollup === "PENDING" || pr.checks.rollup === "EXPECTED"
      ? ob("machine", [], "ci_running", derived.lastPush ?? pr.updatedAt, pr.url + "/checks")
      : null,
  ),
  rule("merging", ({ pr }) =>
    pr.autoMergeEnabledAt || pr.isInMergeQueue ? ob("machine", [], "merging", pr.autoMergeEnabledAt ?? pr.updatedAt, pr.url) : null,
  ),
  rule("mergeable_unknown", ({ pr }) => (pr.mergeable === "UNKNOWN" ? ob("machine", [], "mergeable_unknown", pr.updatedAt, pr.url) : null)),
];

// ---- rules: other people's PRs ---------------------------------------------

export const THEIRS_RULES: Rule<PrInput>[] = [
  rule("review_requested", ({ pr, ctx, derived }) =>
    derived.meRequested ? ob("me", [ctx.me], "review_requested", pr.reviewRequestedAt[ctx.me] ?? latestRequestFor(pr, ctx.me) ?? pr.updatedAt, pr.url) : null,
  ),
  rule("team_review_requested", ({ pr, derived }) =>
    derived.meRequested
      ? null
      : pr.reviewRequests
          .filter((r) => r.kind === "team")
          .map((r) => ob("others", [r.login], "team_review_requested", pr.reviewRequestedAt[r.login] ?? pr.updatedAt, pr.url)),
  ),
  rule("thread_reply", ({ pr, ctx, derived }) => {
    const hits = openThreads(pr).filter(
      ({ thread, last }) =>
        thread.comments.some((c) => derived.isMe(c.author)) && !derived.isMe(last.author) && !derived.isBot(last.author, last.isBot),
    );
    return hits.length ? ob("me", [ctx.me], "thread_reply", oldest(hits.map((h) => h.last.createdAt)), hits[0].thread.url ?? pr.url) : null;
  }),
  rule("conversation_reply", ({ pr, ctx, derived }) => conversationReply(pr, ctx, derived, true)),
  rule("new_commits", ({ pr, ctx, derived }) => {
    const mine = myReview(pr, derived);
    if (!mine || derived.meRequested || !derived.lastPush || time(derived.lastPush) <= time(mine.submittedAt)) return null;
    return ob("me", [ctx.me], "new_commits", derived.lastPush, pr.url);
  }),
  rule("awaiting_fixes", ({ pr, derived }) => {
    const mine = myReview(pr, derived);
    if (!mine || mine.state !== "CHANGES_REQUESTED" || time(derived.lastPush) >= time(mine.submittedAt)) return null;
    return ob("others", [pr.author.login], "awaiting_fixes", mine.submittedAt, pr.url);
  }),
  rule("author_to_merge", ({ pr, derived }) => {
    const mine = myReview(pr, derived);
    if (!mine || mine.state !== "APPROVED" || mine.commitOid !== pr.headRefOid) return null;
    return ob("others", [pr.author.login], "author_to_merge", mine.submittedAt, pr.url);
  }),
  rule("draft", ({ pr }) => (pr.isDraft ? ob("others", [pr.author.login], "draft", pr.createdAt, pr.url) : null)),
];

/** The fallback for other people's PRs when no other row matches. */
const watchingRule = rule<PrInput>("watching", ({ pr }) => ob("others", [pr.author.login], "watching", pr.updatedAt, pr.url));

function myReview(pr: PrFacts, derived: Derived) {
  return pr.latestReviews.find((r) => derived.isMe(r.author)) ?? null;
}

function latestRequestFor(pr: PrFacts, login: string): string | null {
  const key = Object.keys(pr.reviewRequestedAt).find((k) => same(k, login));
  return key ? pr.reviewRequestedAt[key] : null;
}

// ---- overlay ---------------------------------------------------------------

const nudgeRule = rule<{ obligations: Obligation[]; ctx: TurnContext }>("nudge", ({ obligations, ctx }) =>
  obligations
    .filter((o) => o.holder === "others" && NUDGE_REASONS.has(o.reason))
    .filter((o) => ctx.now.getTime() - time(o.since) > NUDGE_HOURS * 3600_000)
    .map((o) => ob("me", o.who, "nudge", new Date(time(o.since) + NUDGE_HOURS * 3600_000).toISOString(), o.ref)),
);

// ---- workspaces with no PR -------------------------------------------------

export interface LocalInput {
  remoteBranchExists: boolean;
  isDirty: boolean;
  ahead: number;
}

/** First match wins, in table order. */
export const LOCAL_RULES: Array<{ id: LocalState; matches(input: LocalInput): boolean }> = [
  { id: "pushed_no_pr", matches: (i) => i.remoteBranchExists },
  { id: "local_work", matches: (i) => i.isDirty || i.ahead > 0 },
  { id: "local_empty", matches: () => true },
];

export function deriveLocal(input: LocalInput): LocalState {
  return LOCAL_RULES.find((r) => r.matches(input))!.id;
}

// ---- entry points ----------------------------------------------------------

export function headlineOf(obligations: Obligation[]): Holder {
  return obligations.reduce<Holder>((best, o) => (HOLDER_RANK[o.holder] < HOLDER_RANK[best] ? o.holder : best), "nobody");
}

export function deriveTurn(pr: PrFacts, ctx: TurnContext): TurnResult {
  const derived = derive(pr, ctx);
  const input: PrInput = { pr, ctx, derived };
  const closed = closedRule.apply(input);
  if (closed.length) return { obligations: closed, headline: "nobody" };

  const isMine = same(pr.author.login, ctx.me);
  let obligations = (isMine ? MINE_RULES : THEIRS_RULES).flatMap((r) => r.apply(input));
  if (!isMine && obligations.length === 0) obligations = watchingRule.apply(input);
  obligations = obligations.concat(nudgeRule.apply({ obligations, ctx }));
  obligations.sort((a, b) => HOLDER_RANK[a.holder] - HOLDER_RANK[b.holder] || time(a.since) - time(b.since));
  return { obligations, headline: headlineOf(obligations) };
}

export function sectionOf(hasPr: boolean, isMine: boolean, headline: Holder | null): Section {
  if (!hasPr) return "local";
  if (headline === "nobody") return "done";
  if (headline === "me") return isMine ? "code" : "review";
  return "waiting";
}
