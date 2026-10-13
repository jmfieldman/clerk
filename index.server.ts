// Clerk's daemon side: the refresher that reads GitHub, and the RPCs and
// lifecycle hooks that feed it.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { clerkRefresh, clerkSnapshot } from "./shared/rpc";
import { clerkSettings, DEFAULT_BOT_LOGINS } from "./shared/settings";
import { Refresher } from "./server/refresher";

/** The desktop app's daemon can start with a minimal PATH. Clerk needs git and gh. */
function widenPath(): void {
  const parts = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) if (!parts.includes(dir)) parts.push(dir);
  process.env.PATH = parts.join(":");
}

export default function contribute(server: PluginServerContext) {
  widenPath();
  const settings = server.registerSettings(clerkSettings);
  const refresher = new Refresher(async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : { githubUsername: "", botLogins: DEFAULT_BOT_LOGINS };
  });

  server.handle(clerkSnapshot, (_input, { paseo }) => {
    refresher.attach(paseo);
    return refresher.snapshot();
  });

  server.handle(clerkRefresh, async (_input, { paseo }) => {
    refresher.attach(paseo);
    return refresher.refreshAll();
  });

  const offs = [
    server.on("workspace.created", ({ workspace }, { paseo }) => {
      refresher.attach(paseo);
      refresher.refreshWorkspace(workspace.id);
    }),
    server.on("workspace.archived", ({ workspace }) => refresher.forget(workspace.id)),
    // The agent may have pushed, commented, or opened a PR.
    server.on("agent.turn_ended", ({ agent }, { paseo }) => {
      refresher.attach(paseo);
      refresher.refreshWorkspace(agent.workspaceId);
    }),
  ];

  return () => {
    refresher.stop();
    for (const off of offs) off();
  };
}
