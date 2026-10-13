// The data model the daemon builds and the sidebar renders. See docs/turn-rules.md.

export type Holder = "me" | "others" | "machine" | "nobody";

/** Lower is more urgent. The headline holder is the lowest rank in the obligation list. */
export const HOLDER_RANK: Record<Holder, number> = { me: 0, others: 1, machine: 2, nobody: 3 };

export interface Obligation {
  holder: Holder;
  /** GitHub logins, or "@org/team" for a team. */
  who: string[];
  /** A rule id from docs/turn-rules.md. */
  reason: string;
  /** ISO time when the obligation started. */
  since: string;
  ref?: string;
}

export type Section = "code" | "review" | "waiting" | "local" | "done";

export const SECTIONS: ReadonlyArray<{ id: Section; title: string; defaultOpen: boolean }> = [
  { id: "code", title: "Your move · code", defaultOpen: true },
  { id: "review", title: "Your move · review", defaultOpen: true },
  { id: "waiting", title: "Waiting", defaultOpen: true },
  { id: "local", title: "Not a PR yet", defaultOpen: false },
  { id: "done", title: "Done", defaultOpen: false },
];

export interface ReviewRequest {
  kind: "user" | "team";
  /** A user login, or "@org/team". */
  login: string;
}

export interface ReviewFact {
  author: string;
  isBot: boolean;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt: string;
  commitOid: string | null;
}

export interface ThreadFact {
  isResolved: boolean;
  url: string | null;
  /** Oldest first. The last entry is the last comment. */
  comments: Array<{ author: string; isBot: boolean; createdAt: string }>;
}

/** Everything the turn rules read about one PR. Built from the GitHub batch query. */
export interface PrFacts {
  id: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  headRefOid: string;
  author: { login: string; isBot: boolean; avatarUrl: string | null };
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  isInMergeQueue: boolean;
  autoMergeEnabledAt: string | null;
  reviewRequests: ReviewRequest[];
  /** login or "@org/team" → newest ReviewRequestedEvent time. */
  reviewRequestedAt: Record<string, string>;
  readyForReviewAt: string | null;
  lastForcePushAt: string | null;
  /** The latest review per reviewer. */
  latestReviews: ReviewFact[];
  threads: ThreadFact[];
  /** Top-level PR comments, oldest first. `mentions` holds the @logins in the body, lower case. */
  conversation: Array<{ author: string; isBot: boolean; createdAt: string; mentions: string[] }>;
  checks: {
    rollup: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;
    headCommittedDate: string | null;
    newestFailureAt: string | null;
    newestCompletedAt: string | null;
  };
  /** From branch protection on the default branch (D1). False when unknown. */
  dismissesStaleReviews: boolean;
}

export type LocalState = "local_empty" | "local_work" | "pushed_no_pr";

export interface WorkspaceStatus {
  workspaceId: string;
  dir: string;
  title: string;
  /** Paseo's project name, for grouping rows inside a section. */
  project: string;
  branch: string | null;
  /** "owner/name" on GitHub, or null. */
  repo: string | null;
  pr: {
    number: number;
    title: string;
    url: string;
    state: PrFacts["state"];
    isDraft: boolean;
    isMine: boolean;
    author: string;
    authorAvatarUrl: string | null;
  } | null;
  localState: LocalState | null;
  /** Local git state, for the archive warning. `unpushed`: commits past the PR head, or null when unknown. */
  local: { isDirty: boolean; unpushed: number | null; managedWorktree: boolean };
  headline: Holder | null;
  obligations: Obligation[];
  section: Section;
  /** When Clerk last read this workspace's PR from GitHub. */
  fetchedAt: string | null;
  error: string | null;
}

export interface Snapshot {
  me: string | null;
  workspaces: WorkspaceStatus[];
  refreshedAt: string | null;
  refreshing: boolean;
  error: string | null;
  rateRemaining: number | null;
}
