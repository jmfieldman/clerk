// A pass-through screen: sidebar items can open a screen but cannot open a
// workspace, and screens can. Opening this screen opens its workspace.
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect } from "react";
import { Text, View } from "react-native";

export const GO_SCREEN_ID = "go";

export function GoScreen({ params, navigation, theme }: PluginScreenProps) {
  const workspaceId = params.workspaceId;
  useEffect(() => {
    if (workspaceId && navigation) navigation.openWorkspace({ workspaceId });
  }, [workspaceId, navigation]);
  const message = !workspaceId ? "No workspace given." : navigation ? "Opening workspace…" : "This Paseo version gives plugins no navigation.";
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>{message}</Text>
    </View>
  );
}
