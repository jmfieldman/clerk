// RPC contracts between Clerk's sidebar (client) and the daemon (server).
// The daemon owns every git and GitHub call. The client only reads snapshots.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { Snapshot } from "./model";

const SnapshotSchema = z.custom<Snapshot>();

/** The current model, from memory. Never waits on GitHub. */
export const clerkSnapshot = defineRpc({
  name: "clerk.snapshot",
  input: z.object({}),
  output: SnapshotSchema,
});

/** Refreshes every workspace from GitHub now, then returns the model. */
export const clerkRefresh = defineRpc({
  name: "clerk.refresh",
  input: z.object({}),
  output: SnapshotSchema,
});
