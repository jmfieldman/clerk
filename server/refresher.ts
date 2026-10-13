// The refresher: the only code that calls GitHub. It keeps one status per
// workspace in memory, writes it to <git-dir>/clerk/status.json, and serves
// the sidebar from memory.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { Holder, PrFacts, Snapshot, WorkspaceStatus } from "../shared/model.ts";
import { details, parseGitHubRemote, probe, type ProbeTarget, type RateInfo } from "./github.ts";
import { deriveLocal, deriveTurn, sectionOf } from "./turn.ts";

const TICK_MS = 15_000;
const PAGE = 200;
const RATE_FLOOR = 500;
const RATE_BACKOFF_MS = 10 * 60_000;
const FILE_VERSION = 2;

/** How often a workspace is due for a GitHub read, by its headline holder. null = never again. */
const CADENCE_MS: Record<Holder | "local", number | null> = {
  machine: 60_000,
  me: 120_000,
  others: 120_000,
  nobody: null,
  local: 300_000,
};

interface Settings {
  githubUsername: string;
  botLogins: string[];
}

interface WorkspaceInfo {
  id: string;
  dir: string;
  title: string;
  project: string;
  branch: string | null;
  remoteUrl: string | null;
  isDirty: boolean;
  ahead: number;
  managedWorktree: boolean;
}

interface Entry {
  info: WorkspaceInfo;
  facts: PrFacts | null;
  signature: string | null;
  remoteBranchExists: boolean;
  fetchedAt: string | null;
  error: string | null;
  status: WorkspaceStatus;
  /** Commits on the worktree that are not in the PR head. Read for done rows only. */
  unpushed: number | null;
  /** The last body written to status.json, to skip identical writes. */
  savedBody?: string;
}

function run(cmd: string, args: string[], cwd?: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 10_000 }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

export class Refresher {
  private paseo: PaseoApi | null = null;
  private entries = new Map<string, Entry>();
  private gitDirs = new Map<string, string | null>();
  private viewer: string | null = null;
  private rate: RateInfo | null = null;
  private pausedUntil = 0;
  private refreshedAt: string | null = null;
  private error: string | null = null;
  private inflight: Promise<void> | null = null;
  private forceAll = false;
  private forceIds = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readSettings: () => Promise<Settings>) {}

  /** Paseo hands the API to handlers and hooks only, so the first caller arms the loop. */
  attach(paseo: PaseoApi): void {
    if (this.paseo) return;
    this.paseo = paseo;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot(): Snapshot {
    return {
      me: this.viewer,
      workspaces: [...this.entries.values()].map((e) => e.status),
      refreshedAt: this.refreshedAt,
      refreshing: this.inflight !== null,
      error: this.error,
      rateRemaining: this.rate?.remaining ?? null,
    };
  }

  /** Refreshes every workspace from GitHub now. Ignores cadence; still obeys the rate floor. */
  async refreshAll(): Promise<Snapshot> {
    this.forceAll = true;
    await this.tick();
    if (this.inflight) await this.inflight;
    return this.snapshot();
  }

  refreshWorkspace(id: string | null): void {
    if (!id) return;
    this.forceIds.add(id);
    void this.tick();
  }

  forget(id: string): void {
    this.entries.delete(id);
  }

  private tick(): Promise<void> {
    if (!this.paseo) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = this.cycle()
      .catch((e) => {
        this.error = e instanceof Error ? e.message : String(e);
        console.error("[clerk] refresh failed:", this.error);
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async cycle(): Promise<void> {
    const settings = await this.readSettings();
    const infos = await this.listWorkspaces();
    const live = new Set(infos.map((i) => i.id));
    for (const id of [...this.entries.keys()]) if (!live.has(id)) this.entries.delete(id);

    const now = Date.now();
    const due: Array<{ entry: Entry; target: ProbeTarget }> = [];
    for (const info of infos) {
      let entry = this.entries.get(info.id);
      if (!entry) {
        entry = await this.load(info);
        this.entries.set(info.id, entry);
      }
      entry.info = info;
      const repo = parseGitHubRemote(info.remoteUrl);
      if (!repo || !info.branch || info.branch === "HEAD") continue;
      const forced = this.forceAll || this.forceIds.has(info.id);
      const cadence = CADENCE_MS[entry.facts ? entry.status.headline ?? "local" : "local"];
      const isDue = forced || !entry.fetchedAt || (cadence !== null && now - Date.parse(entry.fetchedAt) >= cadence);
      if (isDue) due.push({ entry, target: { key: info.id, repo, branch: info.branch } });
    }
    const forcedAny = this.forceAll || this.forceIds.size > 0;
    this.forceAll = false;
    this.forceIds.clear();

    if (due.length && now < this.pausedUntil && !forcedAny) {
      // Rate floor: skip GitHub until the window resets.
    } else if (due.length) {
      await this.fetch(due);
    }

    const me = settings.githubUsername.trim() || this.viewer;
    const botLogins = new Set(settings.botLogins.map((l) => l.trim().toLowerCase()).filter(Boolean));
    for (const entry of this.entries.values()) {
      // Archiving deletes a managed worktree, so done rows need an exact "would lose work" count.
      if (entry.facts && entry.facts.state !== "OPEN") entry.unpushed = await this.unpushedPast(entry.info.dir, entry.facts.headRefOid);
      entry.status = this.statusOf(entry, me, botLogins);
      void this.save(entry);
    }
    this.refreshedAt = new Date().toISOString();
  }

  private async fetch(due: Array<{ entry: Entry; target: ProbeTarget }>): Promise<void> {
    const fetchedAt = new Date().toISOString();
    const probed = await probe(due.map((d) => d.target));
    this.viewer = probed.viewer ?? this.viewer;
    this.noteRate(probed.rate);
    const byKey = new Map(due.map((d) => [d.target.key, d.entry]));
    const needDetails: Array<{ key: string; prId: string; signature: string | null; dismissesStaleReviews: boolean }> = [];
    for (const hit of probed.hits) {
      const entry = byKey.get(hit.key)!;
      entry.remoteBranchExists = hit.remoteBranchExists;
      entry.fetchedAt = fetchedAt;
      entry.error = null;
      if (!hit.prId) {
        entry.facts = null;
        entry.signature = null;
        continue;
      }
      if (!entry.facts || entry.facts.id !== hit.prId || entry.signature !== hit.signature) {
        needDetails.push({ key: hit.key, prId: hit.prId, signature: hit.signature, dismissesStaleReviews: hit.dismissesStaleReviews });
      }
    }
    if (needDetails.length) {
      const full = await details(needDetails);
      this.noteRate(full.rate);
      for (const need of needDetails) {
        const facts = full.facts.get(need.prId);
        if (!facts) continue;
        const entry = byKey.get(need.key)!;
        entry.facts = facts;
        // Record the signature only with its facts, so a failed details read retries next time.
        entry.signature = need.signature;
      }
    }
    this.error = null;
  }

  private noteRate(rate: RateInfo | null): void {
    if (!rate) return;
    this.rate = rate;
    if (rate.remaining < RATE_FLOOR) this.pausedUntil = Math.max(Date.now() + RATE_BACKOFF_MS, Date.parse(rate.resetAt));
  }

  private statusOf(entry: Entry, me: string | null, botLogins: Set<string>): WorkspaceStatus {
    const { info, facts } = entry;
    const base = {
      workspaceId: info.id,
      dir: info.dir,
      title: info.title,
      project: info.project,
      branch: info.branch,
      repo: (() => {
        const repo = parseGitHubRemote(info.remoteUrl);
        return repo ? `${repo.owner}/${repo.name}` : null;
      })(),
      fetchedAt: entry.fetchedAt,
      error: entry.error,
      local: { isDirty: info.isDirty, unpushed: entry.unpushed, managedWorktree: info.managedWorktree },
    };
    if (!facts || !me) {
      return {
        ...base,
        pr: null,
        localState: deriveLocal({ remoteBranchExists: entry.remoteBranchExists, isDirty: info.isDirty, ahead: info.ahead }),
        headline: null,
        obligations: [],
        section: "local",
      };
    }
    const isMine = facts.author.login.toLowerCase() === me.toLowerCase();
    const turn = deriveTurn(facts, { me, now: new Date(), botLogins });
    return {
      ...base,
      pr: {
        number: facts.number,
        title: facts.title,
        url: facts.url,
        state: facts.state,
        isDraft: facts.isDraft,
        isMine,
        author: facts.author.login,
        authorAvatarUrl: facts.author.avatarUrl,
      },
      localState: null,
      headline: turn.headline,
      obligations: turn.obligations,
      section: sectionOf(true, isMine, turn.headline),
    };
  }

  private async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const entries: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.paseo!.workspaces.list({ page: { limit: PAGE, cursor } });
      entries.push(...page.entries);
      cursor = page.pageInfo?.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
    } while (cursor);
    const open = entries.filter((w) => !w.archivingAt);
    return Promise.all(
      open.map(async (w): Promise<WorkspaceInfo> => {
        const dir: string = w.workspaceDirectory ?? w.projectRootPath;
        const git = w.gitRuntime ?? {};
        const branch = git.currentBranch ?? (await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]));
        const remoteUrl = git.remoteUrl ?? (await run("git", ["-C", dir, "remote", "get-url", "origin"]));
        return {
          id: w.id,
          dir,
          title: w.title ?? w.name,
          project: w.projectCustomName ?? w.projectDisplayName ?? dir.split("/").pop() ?? dir,
          branch: branch || null,
          remoteUrl: remoteUrl || null,
          isDirty: Boolean(git.isDirty),
          ahead: git.aheadOfOrigin ?? git.aheadBehind?.ahead ?? 0,
          managedWorktree: Boolean(git.isPaseoOwnedWorktree),
        };
      }),
    );
  }

  /** Commits on HEAD that the PR head does not contain. null when git cannot tell (for example, the head commit is not local). */
  private async unpushedPast(dir: string, headRefOid: string): Promise<number | null> {
    const count = await run("git", ["-C", dir, "rev-list", "--count", `${headRefOid}..HEAD`]);
    return count === null ? null : Number(count);
  }

  // ---- per-worktree file -----------------------------------------------------

  private async gitDir(dir: string): Promise<string | null> {
    if (!this.gitDirs.has(dir)) this.gitDirs.set(dir, await run("git", ["-C", dir, "rev-parse", "--absolute-git-dir"]));
    return this.gitDirs.get(dir) ?? null;
  }

  private async load(info: WorkspaceInfo): Promise<Entry> {
    const entry: Entry = {
      info,
      facts: null,
      signature: null,
      remoteBranchExists: false,
      fetchedAt: null,
      error: null,
      unpushed: null,
      status: {
        workspaceId: info.id,
        dir: info.dir,
        title: info.title,
        project: info.project,
        branch: info.branch,
        repo: null,
        pr: null,
        localState: "local_empty",
        local: { isDirty: info.isDirty, unpushed: null, managedWorktree: info.managedWorktree },
        headline: null,
        obligations: [],
        section: "local",
        fetchedAt: null,
        error: null,
      },
    };
    const gitDir = await this.gitDir(info.dir);
    if (!gitDir) return entry;
    try {
      const saved = JSON.parse(await readFile(join(gitDir, "clerk", "status.json"), "utf8"));
      if (saved.version === FILE_VERSION && saved.branch === info.branch) {
        entry.facts = saved.facts ?? null;
        entry.signature = saved.signature ?? null;
        entry.remoteBranchExists = Boolean(saved.remoteBranchExists);
        // Keep fetchedAt unset so a restart re-probes once; the facts above
        // still skip the expensive details query when nothing changed.
      }
    } catch {
      // No file yet.
    }
    return entry;
  }

  private async save(entry: Entry): Promise<void> {
    const gitDir = await this.gitDir(entry.info.dir);
    if (!gitDir) return;
    const dir = join(gitDir, "clerk");
    const body = JSON.stringify(
      {
        version: FILE_VERSION,
        branch: entry.info.branch,
        signature: entry.signature,
        remoteBranchExists: entry.remoteBranchExists,
        facts: entry.facts,
        status: entry.status,
      },
      null,
      2,
    );
    if (body === entry.savedBody) return;
    entry.savedBody = body;
    try {
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `status.json.${process.pid}.tmp`);
      await writeFile(tmp, body);
      await rename(tmp, join(dir, "status.json"));
    } catch (e) {
      console.error("[clerk] could not write status for", entry.info.dir, e);
    }
  }
}
