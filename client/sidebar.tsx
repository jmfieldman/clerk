// The Clerk sidebar header: workspaces grouped by whose turn it is.
// It only reads the daemon's snapshot; the daemon does every GitHub call.
import { usePaseo, useRpc, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { ExternalLink, SidebarRow, SidebarSeparator } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View, useWindowDimensions } from "react-native";
import { SECTIONS, type Obligation, type Section, type Snapshot, type WorkspaceStatus } from "../shared/model";
import { clerkRefresh, clerkSnapshot } from "../shared/rpc";
import { GO_SCREEN_ID } from "./go";

const POLL_MS = 3000;
/** The rows scroll inside this share of the window, so the native list below stays reachable. */
const MAX_HEIGHT_SHARE = 0.6;
const OPEN_KEY = "clerk.sidebar.open";

// ---- persisted open/closed state -------------------------------------------

type OpenState = Record<string, boolean>;
let openFallback: OpenState = {};

function readOpen(): OpenState {
  try {
    const raw = globalThis.localStorage?.getItem(OPEN_KEY);
    return raw ? { ...openFallback, ...JSON.parse(raw) } : openFallback;
  } catch {
    return openFallback;
  }
}

function writeOpen(state: OpenState): void {
  openFallback = state;
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify(state));
  } catch {
    // Session-only on clients without storage.
  }
}

// ---- formatting ------------------------------------------------------------

export function age(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return minutes + "m";
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + "h";
  return Math.round(hours / 24) + "d";
}

function people(who: string[]): string {
  const shown = who.slice(0, 2).map((w) => (w.startsWith("@") ? w.split("/").pop()! : "@" + w));
  return shown.join(", ") + (who.length > 2 ? " +" + (who.length - 2) : "");
}

export function reasonLabel(o: Obligation, status: WorkspaceStatus): string {
  switch (o.reason) {
    case "draft":
      return "draft";
    case "conflict":
      return "conflict";
    case "ci_failed":
      return "CI failed";
    case "changes_requested":
      return "changes requested";
    case "thread_reply":
      return "reply to thread";
    case "conversation_reply":
      return "new reply";
    case "bot_finding":
      return "bot finding";
    case "ready_to_merge":
      return "ready to merge";
    case "stale_approval":
      return "re-approval " + people(o.who);
    case "request_review":
      return "request a review";
    case "review_requested":
      return o.holder === "me" ? "review requested" : "review " + people(o.who);
    case "rereview":
      return "re-review " + people(o.who);
    case "awaiting_reply":
      return "reply from " + people(o.who);
    case "ci_running":
      return "CI running";
    case "merging":
      return "merging";
    case "mergeable_unknown":
      return "checking merge";
    case "team_review_requested":
      return "team " + people(o.who);
    case "new_commits":
      return "new commits";
    case "awaiting_fixes":
      return "awaiting fixes";
    case "author_to_merge":
      return "approved";
    case "watching":
      return "watching";
    case "nudge":
      return "nudge " + people(o.who);
    case "closed":
      return status.pr?.state === "MERGED" ? "merged" : "closed";
    default:
      return o.reason;
  }
}

const LOCAL_LABEL: Record<string, string> = {
  local_empty: "no changes",
  local_work: "local work",
  pushed_no_pr: "pushed, no PR",
};

type Tone = "danger" | "warning" | "success" | "accent" | "muted";

/** One color per meaning: red blocks you, amber needs a person, green is good news,
 * accent is someone asking you, gray is waiting or informational. */
const REASON_TONE: Record<string, Tone> = {
  ci_failed: "danger",
  conflict: "danger",
  changes_requested: "danger",
  thread_reply: "warning",
  bot_finding: "warning",
  request_review: "warning",
  stale_approval: "warning",
  nudge: "warning",
  ready_to_merge: "success",
  author_to_merge: "success",
  review_requested: "accent",
};

function toneOf(o: Obligation, status: WorkspaceStatus): Tone {
  if (o.reason === "closed") return status.pr?.state === "MERGED" ? "success" : "muted";
  if (o.reason === "review_requested" && o.holder !== "me") return "muted";
  return REASON_TONE[o.reason] ?? "muted";
}

function colorOf(tone: Tone, theme: PluginTheme): string {
  const c = theme.colors;
  switch (tone) {
    case "danger":
      return c.statusDanger;
    case "warning":
      return c.statusWarning;
    case "success":
      return c.statusSuccess;
    case "accent":
      return c.accent;
    default:
      return c.foregroundMuted;
  }
}

/** Oldest obligation first: the longest wait goes to the top. */
function sortKey(status: WorkspaceStatus): number {
  if (status.section === "done") return -Date.parse(status.obligations[0]?.since ?? "1970-01-01");
  if (status.section === "local") return 0;
  return Date.parse(status.obligations[0]?.since ?? "2100-01-01");
}

/** Groups a section's rows by project, projects in name order; row order is kept. */
function byProject(items: WorkspaceStatus[]): Array<[string, WorkspaceStatus[]]> {
  const groups = new Map<string, WorkspaceStatus[]>();
  for (const item of items) {
    const key = item.project || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// ---- row -------------------------------------------------------------------

function Chip({ label, color, filled }: { label: string; color: string; filled?: boolean }) {
  return (
    <View
      style={{
        borderRadius: 999,
        borderWidth: 1,
        borderColor: filled ? color : "transparent",
        paddingHorizontal: 7,
        paddingVertical: 1,
        overflow: "hidden",
      }}
    >
      {filled ? <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: color, opacity: 0.18 }} /> : null}
      <Text numberOfLines={1} style={{ color, fontSize: 10, fontWeight: filled ? "700" : "500" }}>
        {label}
      </Text>
    </View>
  );
}

function Avatar({ status, theme }: { status: WorkspaceStatus; theme: PluginTheme }) {
  const [failed, setFailed] = useState(false);
  const c = theme.colors;
  const url = status.pr?.authorAvatarUrl;
  if (url && !failed) return <Image source={{ uri: url }} onError={() => setFailed(true)} style={{ width: 22, height: 22, borderRadius: 11 }} />;
  if (status.pr) {
    return (
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: c.foreground, fontSize: 10, fontWeight: "700" }}>{status.pr.author.slice(0, 1).toUpperCase()}</Text>
      </View>
    );
  }
  return (
    <View style={{ width: 22, height: 22, alignItems: "center", justifyContent: "center" }}>
      <Icon name="GitBranch" size={14} color={c.foregroundMuted} />
    </View>
  );
}

const STALE_MS = 48 * 3600_000;

function ArchiveControl({ status, theme, onArchive }: { status: WorkspaceStatus; theme: PluginTheme; onArchive(): Promise<void> }) {
  const c = theme.colors;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unpushed = status.local.unpushed;
  const risky = status.local.isDirty || unpushed === null || unpushed > 0;
  if (busy) return <ActivityIndicator size="small" color={c.foregroundMuted} />;
  if (!confirming) {
    return (
      <Pressable accessibilityLabel="Archive this workspace" onPress={() => setConfirming(true)} hitSlop={6} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4 }}>
        <Icon name="Archive" size={13} color={c.foregroundMuted} />
        <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>{error ? "retry" : "archive"}</Text>
      </Pressable>
    );
  }
  const warning = [
    status.local.isDirty ? "uncommitted changes" : null,
    unpushed === null ? "unknown local commits" : unpushed > 0 ? unpushed + " unpushed commit" + (unpushed === 1 ? "" : "s") : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      {risky ? <Text style={{ color: c.statusDanger, fontSize: 10, fontWeight: "700" }}>{warning} will be lost</Text> : null}
      <Pressable
        accessibilityLabel="Confirm archive"
        onPress={async () => {
          setBusy(true);
          setError(null);
          try {
            await onArchive();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setConfirming(false);
          } finally {
            setBusy(false);
          }
        }}
        style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, borderWidth: 1, borderColor: c.statusDanger }}
      >
        <Text style={{ color: c.statusDanger, fontSize: 10, fontWeight: "700" }}>{risky ? "archive anyway" : "archive"}</Text>
      </Pressable>
      <Pressable accessibilityLabel="Cancel archive" onPress={() => setConfirming(false)} style={{ paddingHorizontal: 4 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>cancel</Text>
      </Pressable>
    </View>
  );
}

function WorkspaceRow({ status, theme, onOpen, onArchive }: { status: WorkspaceStatus; theme: PluginTheme; onOpen(): void; onArchive(): Promise<void> }) {
  const c = theme.colors;
  const top = status.obligations[0];
  const chips = [...new Map(status.obligations.map((o) => [reasonLabel(o, status), o])).entries()].slice(0, 2);
  const stale = top?.holder === "me" && Date.now() - Date.parse(top.since) > STALE_MS;
  return (
    <Pressable
      onPress={onOpen}
      accessibilityLabel={(status.branch ?? status.title) + (top ? ", " + reasonLabel(top, status) : "")}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        marginHorizontal: 8,
        marginVertical: 3,
        paddingVertical: 8,
        paddingHorizontal: 10,
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        borderRadius: 8,
        backgroundColor: pressed ? c.surface2 : hovered ? c.surface2 : c.surface1,
      })}
    >
      <View style={{ paddingTop: 2 }}>
        <Avatar status={status} theme={theme} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 13, fontWeight: "600" }}>
            {status.branch ?? status.title}
          </Text>
          <Text style={{ color: stale ? c.statusWarning : c.foregroundMuted, fontSize: 11, fontWeight: stale ? "700" : "400" }}>
            {age(top?.since)}
          </Text>
        </View>
        {status.pr ? (
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, minWidth: 0 }}>
            <ExternalLink href={status.pr.url} accessibilityLabel={"Open PR #" + status.pr.number + " on GitHub"}>
              <Text style={{ color: c.foreground, fontSize: 11, fontWeight: "700", textDecorationLine: "underline" }}>{"#" + status.pr.number}</Text>
            </ExternalLink>
            <Text numberOfLines={1} style={{ flex: 1, color: c.foregroundMuted, fontSize: 11 }}>
              {status.pr.title}
            </Text>
          </View>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
          {status.localState ? <Chip label={LOCAL_LABEL[status.localState] ?? status.localState} color={c.foregroundMuted} filled /> : null}
          {chips.map(([label, o], i) => (
            <Chip key={label} label={label} color={i === 0 ? colorOf(toneOf(o, status), theme) : c.foregroundMuted} filled={i === 0} />
          ))}
          {status.section === "done" ? (
            <View style={{ marginLeft: "auto" }}>
              <ArchiveControl status={status} theme={theme} onArchive={onArchive} />
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const SECTION_TONE: Record<Section, Tone> = { code: "warning", review: "warning", waiting: "muted", local: "muted", done: "success" };

function SectionHeader({ title, count, open, tone, first, theme, onPress }: { title: string; count: number; open: boolean; tone: Tone; first: boolean; theme: PluginTheme; onPress(): void }) {
  const c = theme.colors;
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={title + ", " + count}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        marginTop: first ? 4 : 14,
        paddingTop: first ? 4 : 12,
        paddingBottom: 4,
        paddingHorizontal: 12,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: c.border,
        opacity: hovered ? 0.8 : 1,
      })}
    >
      <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={c.foregroundMuted} />
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colorOf(tone, theme) }} />
      <Text style={{ flex: 1, color: c.foreground, fontSize: 13, fontWeight: "700" }}>{title}</Text>
      <View style={{ minWidth: 20, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: c.surface2, alignItems: "center" }}>
        <Text style={{ color: c.foreground, fontSize: 11, fontWeight: "700" }}>{count}</Text>
      </View>
    </Pressable>
  );
}

// ---- sidebar item ----------------------------------------------------------

/** Sidebar props do not document `navigation`; use it if this Paseo passes it anyway. */
type MaybeNavigable = PluginSidebarItemProps & { navigation?: { openWorkspace(input: { workspaceId: string }): void } };

export function ClerkSidebar(props: PluginSidebarItemProps) {
  const { theme, openScreen } = props;
  const c = theme.colors;
  const paseo = usePaseo();
  const getSnapshot = useRpc(clerkSnapshot);
  const [archived, setArchived] = useState<ReadonlySet<string>>(new Set());
  const refreshAll = useRpc(clerkRefresh);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<OpenState>(readOpen);
  const [, setNow] = useState(Date.now());
  const { height: windowHeight } = useWindowDimensions();

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const next = (await getSnapshot({})) as Snapshot;
        if (live) {
          setSnapshot(next);
          setLoadError(null);
          setNow(Date.now());
        }
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [getSnapshot]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setSnapshot((await refreshAll({})) as Snapshot);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [refreshAll]);

  const toggle = (key: string, fallback: boolean) => {
    const next = { ...open, [key]: !(open[key] ?? fallback) };
    writeOpen(next);
    setOpen(next);
  };

  const openWorkspace = (workspaceId: string) => {
    const navigation = (props as MaybeNavigable).navigation;
    if (navigation?.openWorkspace) navigation.openWorkspace({ workspaceId });
    else openScreen({ screenId: GO_SCREEN_ID, params: { workspaceId } });
  };

  const archive = async (workspaceId: string) => {
    await paseo.workspaces.archive(workspaceId);
    setArchived((prev) => new Set(prev).add(workspaceId));
  };

  const workspaces = (snapshot?.workspaces ?? []).filter((w) => !archived.has(w.workspaceId));
  const yourMove = workspaces.filter((w) => w.section === "code" || w.section === "review").length;
  const expanded = open.clerk ?? true;
  const busy = refreshing || snapshot?.refreshing;
  const problem = loadError ?? snapshot?.error ?? null;

  const header = (
    <SidebarRow
      id="header"
      icon={expanded ? "ChevronDown" : "ChevronRight"}
      label={yourMove ? "Clerk · " + yourMove + " your move" : "Clerk"}
      onPress={() => toggle("clerk", true)}
      trailing={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {problem ? <Icon name="TriangleAlert" size={12} color={c.statusWarning} /> : null}
          <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>{age(snapshot?.refreshedAt)}</Text>
          <Pressable accessibilityLabel="Refresh Clerk from GitHub" disabled={refreshing} onPress={refresh} hitSlop={8} style={{ padding: 4 }}>
            {busy ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : <Icon name="RefreshCw" size={14} color={c.foregroundMuted} />}
          </Pressable>
        </View>
      }
    />
  );
  if (!expanded) return header;

  const groups = SECTIONS.map((section) => ({
    section,
    items: workspaces.filter((w) => w.section === section.id).sort((a, b) => sortKey(a) - sortKey(b) || a.title.localeCompare(b.title)),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      {header}
      <ScrollView style={{ maxHeight: Math.round(windowHeight * MAX_HEIGHT_SHARE) }} nestedScrollEnabled showsVerticalScrollIndicator>
      {problem ? <SidebarRow id="problem" icon="TriangleAlert" label={problem} onPress={() => {}} /> : null}
      {!snapshot && !problem ? <SidebarRow id="loading" icon="Loader" label="Loading…" onPress={() => {}} /> : null}
      {groups.map(({ section, items }, index) => {
        const key = "section:" + (section.id as Section);
        const sectionOpen = open[key] ?? section.defaultOpen;
        return (
          <View key={section.id}>
            <SectionHeader
              title={section.title}
              count={items.length}
              open={sectionOpen}
              tone={SECTION_TONE[section.id]}
              first={index === 0}
              theme={theme}
              onPress={() => toggle(key, section.defaultOpen)}
            />
            {sectionOpen
              ? byProject(items).map(([project, rows]) => (
                  <View key={project}>
                    <Text numberOfLines={1} style={{ marginLeft: 18, marginTop: 8, marginBottom: 1, color: c.foregroundMuted, opacity: 0.7, fontSize: 9, fontWeight: "700", letterSpacing: 1 }}>
                      {project.toUpperCase()}
                    </Text>
                    {rows.map((w) => (
                      <WorkspaceRow key={w.workspaceId} status={w} theme={theme} onOpen={() => openWorkspace(w.workspaceId)} onArchive={() => archive(w.workspaceId)} />
                    ))}
                  </View>
                ))
              : null}
          </View>
        );
      })}
      </ScrollView>
      <SidebarSeparator />
    </>
  );
}
