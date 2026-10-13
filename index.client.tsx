// Clerk's app side: the sidebar header item, the settings screen, and a
// pass-through screen that lets a sidebar row open a workspace.
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GO_SCREEN_ID, GoScreen } from "./client/go";
import { ClerkSettings } from "./client/settings";
import { ClerkSidebar } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: GO_SCREEN_ID, title: "Clerk", Component: GoScreen }),
    client.addSidebarHeaderItem({ id: "clerk", title: "Clerk", Component: ClerkSidebar }),
    client.addSettingsScreen({ id: "settings", title: "Clerk", icon: "ListTodo", Component: ClerkSettings }),
  ];
  return async () => {
    for (const remove of removers) await remove();
  };
}
