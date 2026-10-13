// Clerk's settings screen: who "me" is, and which logins count as bots.
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { clerkSettings } from "../shared/settings";

export function ClerkSettings({ theme }: PluginSurfaceProps) {
  const state = useSettings(clerkSettings);
  const [username, setUsername] = useState("");
  const [bots, setBots] = useState("");
  const ready = state.status === "ready";

  useEffect(() => {
    if (state.status !== "ready") return;
    setUsername(state.values.githubUsername);
    setBots(state.values.botLogins.join(", "));
  }, [state.status, ready && state.revision]);

  if (state.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted, padding: 24 }}>Loading…</Text>;
  if (state.status !== "ready") return <Text style={{ color: theme.colors.statusDanger, padding: 24 }}>{state.error}</Text>;

  const save = () =>
    state.save(
      {
        githubUsername: username.trim(),
        botLogins: bots
          .split(",")
          .map((b) => b.trim())
          .filter(Boolean),
      },
      state.revision,
    );

  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
      <SettingsSection title="GitHub">
        <SettingsInput
          key={"user-" + state.revision}
          label="GitHub username"
          hint="Leave empty to use the account that gh is signed in as."
          initialValue={username}
          placeholder="jmfieldman"
          onChangeText={setUsername}
        />
        <SettingsInput
          key={"bots-" + state.revision}
          label="Bot logins"
          hint="Comma-separated. Threads from these logins count as bot findings, not replies. GitHub Bot accounts are always bots."
          initialValue={bots}
          onChangeText={setBots}
        />
        <SettingsAction label="Save" actionLabel={state.saving ? "Saving…" : "Save"} disabled={state.saving} onPress={save} error={state.saveError} />
      </SettingsSection>
    </ScrollView>
  );
}
