// GitHub reads for Clerk, through `gh api graphql`. Two phases keep the cost low:
//   1. probe: one cheap aliased query for every due workspace (which PR, did it change?)
//   2. details: the full PR fragment, only for PRs whose signature changed
import { execFile } from "node:child_process";
import type { PrFacts, ReviewFact, ThreadFact } from "../shared/model.ts";

const PROBE_CHUNK = 40;
const DETAIL_CHUNK = 10;

export interface RepoRef {
  owner: string;
  name: string;
}

export interface ProbeTarget {
  key: string;
  repo: RepoRef;
  branch: string;
}

export interface ProbeHit {
  key: string;
  prId: string | null;
  /** Changes when anything the turn rules read may have changed. */
  signature: string | null;
  remoteBranchExists: boolean;
  dismissesStaleReviews: boolean;
}

export interface RateInfo {
  remaining: number;
  resetAt: string;
}

export class GitHubError extends Error {}

export function parseGitHubRemote(url: string | null | undefined): RepoRef | null {
  if (!url) return null;
  const match = url.trim().match(/github\.com[:/]+([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? { owner: match[1], name: match[2] } : null;
}

function gql(query: string): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["api", "graphql", "-f", `query=${query}`], { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }, (error, stdout, stderr) => {
      // gh exits non-zero on partial GraphQL errors but still prints data.
      let body: any = null;
      try {
        body = stdout ? JSON.parse(stdout) : null;
      } catch {
        body = null;
      }
      if (body?.data) return resolve(body);
      reject(new GitHubError((stderr || error?.message || "gh api graphql failed").trim()));
    });
  });
}

const str = (value: string) => JSON.stringify(value);

function rateOf(body: any): RateInfo | null {
  const rate = body?.data?.rateLimit;
  return rate ? { remaining: rate.remaining, resetAt: rate.resetAt } : null;
}

/** Phase 1. One request per chunk of targets; the viewer login comes back with the first chunk. */
export async function probe(targets: ProbeTarget[]): Promise<{ hits: ProbeHit[]; viewer: string | null; rate: RateInfo | null }> {
  const hits: ProbeHit[] = [];
  let viewer: string | null = null;
  let rate: RateInfo | null = null;
  for (let start = 0; start < targets.length; start += PROBE_CHUNK) {
    const chunk = targets.slice(start, start + PROBE_CHUNK);
    const byRepo = new Map<string, Array<{ target: ProbeTarget; alias: string }>>();
    chunk.forEach((target, i) => {
      const repoKey = `${target.repo.owner}/${target.repo.name}`;
      if (!byRepo.has(repoKey)) byRepo.set(repoKey, []);
      byRepo.get(repoKey)!.push({ target, alias: `w${i}` });
    });
    const repoBlocks = [...byRepo.entries()].map(([, entries], r) => {
      const { owner, name } = entries[0].target.repo;
      const fields = entries
        .map(
          ({ target, alias }) => `
        ${alias}: pullRequests(headRefName: ${str(target.branch)}, first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes { id state updatedAt headRefOid mergeable isDraft
            commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
        }
        ${alias}ref: ref(qualifiedName: ${str("refs/heads/" + target.branch)}) { id }`,
        )
        .join("");
      return `r${r}: repository(owner: ${str(owner)}, name: ${str(name)}) {
        defaultBranchRef { branchProtectionRule { dismissesStaleReviews } }${fields}
      }`;
    });
    const body = await gql(`query { viewer { login } rateLimit { remaining resetAt } ${repoBlocks.join("\n")} }`);
    viewer ??= body.data.viewer?.login ?? null;
    rate = rateOf(body) ?? rate;
    [...byRepo.values()].forEach((entries, r) => {
      const repo = body.data[`r${r}`];
      const dismisses = Boolean(repo?.defaultBranchRef?.branchProtectionRule?.dismissesStaleReviews);
      for (const { target, alias } of entries) {
        const nodes: any[] = repo?.[alias]?.nodes ?? [];
        const pr = nodes.find((n) => n.state === "OPEN") ?? nodes[0] ?? null;
        const rollup = pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? "NONE";
        hits.push({
          key: target.key,
          prId: pr?.id ?? null,
          signature: pr ? [pr.state, pr.updatedAt, pr.headRefOid, pr.mergeable, pr.isDraft, rollup, dismisses].join("|") : null,
          remoteBranchExists: Boolean(repo?.[`${alias}ref`]?.id),
          dismissesStaleReviews: dismisses,
        });
      }
    });
  }
  return { hits, viewer, rate };
}

const PR_FRAGMENT = `
fragment ClerkPr on PullRequest {
  id number title url state isDraft createdAt updatedAt mergedAt closedAt headRefOid
  author { __typename login avatarUrl(size: 64) }
  reviewDecision mergeable mergeStateStatus isInMergeQueue
  autoMergeRequest { enabledAt }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { combinedSlug } } } }
  latestReviews(first: 30) { nodes { author { __typename login } state submittedAt commit { oid } } }
  comments(last: 20) { nodes { author { __typename login } createdAt body } }
  reviewThreads(first: 50) { nodes { isResolved
    comments(last: 10) { nodes { author { __typename login } createdAt url } } } }
  timelineItems(last: 50, itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT, HEAD_REF_FORCE_PUSHED_EVENT]) {
    nodes { __typename
      ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { combinedSlug } } }
      ... on ReadyForReviewEvent { createdAt }
      ... on HeadRefForcePushedEvent { createdAt } } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state
    contexts(last: 100) { nodes { __typename
      ... on CheckRun { conclusion completedAt }
      ... on StatusContext { state createdAt } } } } } } }
}`;

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

function reviewerLogin(reviewer: any): string | null {
  if (!reviewer) return null;
  if (reviewer.__typename === "Team") return reviewer.combinedSlug ? "@" + reviewer.combinedSlug : null;
  return reviewer.login ?? null;
}

function toFacts(node: any, dismissesStaleReviews: boolean): PrFacts {
  const requestedAt: Record<string, string> = {};
  let readyForReviewAt: string | null = null;
  let lastForcePushAt: string | null = null;
  for (const item of node.timelineItems?.nodes ?? []) {
    if (item.__typename === "ReviewRequestedEvent") {
      const login = reviewerLogin(item.requestedReviewer);
      if (login) requestedAt[login] = item.createdAt;
    } else if (item.__typename === "ReadyForReviewEvent") readyForReviewAt = item.createdAt;
    else if (item.__typename === "HeadRefForcePushedEvent") lastForcePushAt = item.createdAt;
  }
  const commit = node.commits?.nodes?.[0]?.commit ?? null;
  let newestFailureAt: string | null = null;
  let newestCompletedAt: string | null = null;
  for (const ctx of commit?.statusCheckRollup?.contexts?.nodes ?? []) {
    const at = ctx.__typename === "CheckRun" ? ctx.completedAt : ctx.createdAt;
    const failed = ctx.__typename === "CheckRun" ? FAILED.has(ctx.conclusion) : ctx.state === "FAILURE" || ctx.state === "ERROR";
    if (at && (!newestCompletedAt || at > newestCompletedAt)) newestCompletedAt = at;
    if (failed && at && (!newestFailureAt || at > newestFailureAt)) newestFailureAt = at;
  }
  const author = (a: any) => ({ login: a?.login ?? "ghost", isBot: a?.__typename === "Bot" });
  return {
    id: node.id,
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state,
    isDraft: node.isDraft,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    mergedAt: node.mergedAt,
    closedAt: node.closedAt,
    headRefOid: node.headRefOid,
    author: { ...author(node.author), avatarUrl: node.author?.avatarUrl ?? null },
    reviewDecision: node.reviewDecision ?? null,
    mergeable: node.mergeable,
    mergeStateStatus: node.mergeStateStatus,
    isInMergeQueue: Boolean(node.isInMergeQueue),
    autoMergeEnabledAt: node.autoMergeRequest?.enabledAt ?? null,
    reviewRequests: (node.reviewRequests?.nodes ?? [])
      .map((n: any) => n.requestedReviewer)
      .filter(Boolean)
      .map((r: any) => ({ kind: r.__typename === "Team" ? "team" : "user", login: reviewerLogin(r) }))
      .filter((r: any) => r.login),
    reviewRequestedAt: requestedAt,
    readyForReviewAt,
    lastForcePushAt,
    latestReviews: (node.latestReviews?.nodes ?? []).map(
      (r: any): ReviewFact => ({ ...author(r.author), author: r.author?.login ?? "ghost", state: r.state, submittedAt: r.submittedAt, commitOid: r.commit?.oid ?? null }),
    ),
    threads: (node.reviewThreads?.nodes ?? []).map(
      (t: any): ThreadFact => ({
        isResolved: t.isResolved,
        url: t.comments?.nodes?.[0]?.url ?? null,
        comments: (t.comments?.nodes ?? []).map((c: any) => ({ ...author(c.author), author: c.author?.login ?? "ghost", createdAt: c.createdAt })),
      }),
    ),
    conversation: (node.comments?.nodes ?? []).map((c: any) => ({
      ...author(c.author),
      author: c.author?.login ?? "ghost",
      createdAt: c.createdAt,
      mentions: [...String(c.body ?? "").matchAll(/(?:^|[^\w`])@([A-Za-z0-9-]+)/g)].map((m) => m[1].toLowerCase()),
    })),
    checks: {
      rollup: commit?.statusCheckRollup?.state ?? null,
      headCommittedDate: commit?.committedDate ?? null,
      newestFailureAt,
      newestCompletedAt,
    },
    dismissesStaleReviews,
  };
}

/** Phase 2. Full facts for the given PR node ids. */
export async function details(
  requests: Array<{ prId: string; dismissesStaleReviews: boolean }>,
): Promise<{ facts: Map<string, PrFacts>; rate: RateInfo | null }> {
  const facts = new Map<string, PrFacts>();
  let rate: RateInfo | null = null;
  const dismissById = new Map(requests.map((r) => [r.prId, r.dismissesStaleReviews]));
  const ids = [...dismissById.keys()];
  for (let start = 0; start < ids.length; start += DETAIL_CHUNK) {
    const chunk = ids.slice(start, start + DETAIL_CHUNK);
    const body = await gql(`${PR_FRAGMENT}
query { rateLimit { remaining resetAt } nodes(ids: [${chunk.map(str).join(", ")}]) { ...ClerkPr } }`);
    rate = rateOf(body) ?? rate;
    for (const node of body.data.nodes ?? []) if (node?.id) facts.set(node.id, toFacts(node, dismissById.get(node.id) ?? false));
  }
  return { facts, rate };
}
