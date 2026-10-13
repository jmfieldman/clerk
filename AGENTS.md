# AGENTS.md

Clerk is a Paseo plugin. It shows the status of every open Paseo workspace in the sidebar header.

## Layout

- `paseo-plugin.json`: the plugin manifest.
- `index.client.tsx`, `client/`: the sidebar item and screens. Client code reads data. It does not call GitHub.
- `index.server.ts`, `server/`: the daemon side. Only the server calls git and GitHub.
- `shared/`: RPC contracts and types that the client and the server both use.
- `docs/turn-rules.md`: the turn rules and the decisions behind them.

## Turn rules are spec-first

`docs/turn-rules.md` is the source of truth for turn behavior. The code follows the document. The document never follows the code.

When a request changes turn behavior ("make team requests my turn", "nudge after 12 hours"), do these steps in this order:

1. Edit `docs/turn-rules.md`. Change the decision row and every rule row that cites it.
2. Edit the rule in code so that it agrees with the document.
3. Add or change the test for each rule row that changed. Each rule id in the document has one test named with that id.
4. Run `npm run check`. Do not stop until it passes.
5. In the reply, quote the changed rows from the document.

If a request is ambiguous, ask one question before you edit. Do not invent a rule that the document does not state.

## Rule ids

Each rule has an id in backticks in the first column of a rule table, for example `ci_failed`. The same id is used in three places:

- the rule table in `docs/turn-rules.md`
- the rule implementation in code
- the test name

`npm run check` fails if an id is in one place and not in the others. It also fails if an id has no label in `client/sidebar.tsx` (`reasonLabel`, or `LOCAL_LABEL` for the no-PR states).

## Commands

- `npm run typecheck`: type-check the client and the server.
- `npm run check`: typecheck, tests, and the rule-id consistency check.
- `paseo plugin reload clerk`: load the new code into the local Paseo daemon.
- `paseo plugin logs clerk`: read the plugin output.

## Rules

- Do not call GitHub from client code.
- Do not hard-code a GitHub login. Use `viewer { login }`, or the "GitHub username" setting.
- Use theme colors from the `theme` prop. Do not hard-code colors.
