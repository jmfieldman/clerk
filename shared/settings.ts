// Clerk's host settings: who "me" is, and which logins count as bots.
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_BOT_LOGINS = ["devin-ai-integration", "cursor", "coderabbitai", "github-actions", "copilot"];

export const clerkSettings = defineSettings({
  id: "clerk",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Empty: use the GitHub account that `gh` is signed in as. */
    githubUsername: z.string().default(""),
    /** Logins treated as bots, in addition to GitHub Bot accounts and logins that end in "[bot]". */
    botLogins: z.array(z.string()).default(DEFAULT_BOT_LOGINS),
  }),
});
