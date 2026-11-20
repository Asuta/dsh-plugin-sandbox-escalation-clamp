# Sandbox escalation clamp

Withdraws the `sandbox_permissions` + `justification` pair from the model-facing
schema of confining tools, and repairs escalation arguments that cannot produce a
grant, for every agent whose session can never widen its sandbox.

## Install

In DSH Desktop, open **Plugins** → **Add plugin** and pass the repository URL or a
local checkout directory:

```
https://github.com/Asuta/dsh-plugin-sandbox-escalation-clamp
```

The bundle links into the active profile and activates through HMR. Enable or
disable its row in **Plugins** to toggle the clamp for every session in that
profile.

A **local checkout link** is not hot-swapped in place: editing `index.js` in a
linked directory keeps the already-loaded module running until the plugin row is
toggled off and on again in **Plugins** (or DSH restarts). Toggling re-imports the
module, which is enough for this plugin because it keeps no persistent state.

## Why

DSH advertises those two parameters on tools such as `pwsh`, `bash`, `write`, and
`edit` whenever a confining capability is mounted. They are only meaningful for
one-shot escalation: `approval = never`, or a session already at
`danger-full-access`, can never grant one. A model that fills them anyway is
refused inside the tool body before the command runs:

```
Error: invalid justification: expected a non-empty sentence
Error: sandbox escalation to "workspace-write" is not strictly wider than this call's current "danger-full-access" mode
```

A model that keeps re-emitting the same parameter then loops until the turn is
aborted. An earlier version of this plugin only clamped the tool names listed in
its own configuration, so the trap survived on `write` and `edit` — the clamp now
discovers its targets instead of trusting a hand-maintained list.

## What it does

For each agent (including agents that already existed when the plugin loaded), it
registers an agent-scoped shadow of **every** tool that advertises the pair:

- **Hide** — the shadow's `parameters` omit `sandbox_permissions` and
  `justification` while the session cannot escalate. The getter re-evaluates the
  session's approval policy and standing mode on every schema projection, so a
  mid-session policy switch is honored without re-registering.
- **Repair** — the shadow delegates execution to the inherited tool definition
  after dropping escalation arguments that cannot produce a grant: the session
  already cannot widen, the requested mode is not strictly wider than the
  standing mode, or the justification is blank. The call then runs normally, even
  when an older turn's arguments are replayed verbatim.
- **Explain** — an escalation error that still reaches the model is rewritten into
  its original message plus one instruction naming the tool: drop the pair and
  re-issue the identical call.

Legitimate escalation is untouched: when the session is confined below
`danger-full-access` and approvals are `ask`, a strictly wider request with a
non-empty justification passes through unchanged.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `discover` | `true` | Shadow every tool the agent resolves that advertises either escalation parameter |
| `tools` | `[]` | Extra tool names to clamp even when discovery does not see them |
| `exclude` | `[]` | Tool names to leave untouched (for example a tool whose own escalation handling you want the model to see) |
| `hideEscalationFields` | `true` | Remove the escalation pair from the shadow's schema while the session cannot escalate |
| `repairCalls` | `true` | Drop escalation arguments that cannot produce a grant before the tool runs |
| `explainErrors` | `true` | Append the actionable instruction to a remaining escalation error |

`run_code` is always skipped: it is the reserved PTC transport, cannot be
shadowed, and its nested calls are clamped by the tools they reach.

Set `discover: false` together with an explicit `tools` list to clamp a fixed
subset again.

## Toggle

The capability lives entirely in this bundle. Disable its row in **Plugins** to
remove the shadows and restore the stock schemas and messages for every session;
re-enable to install them again. Turn it off when a session genuinely relies on
escalation prompts and you want the model to see the parameters.

## Limits

- The inherited definition is captured once per agent, because an agent-scoped
  shadow hides the inherited entry from further lookup. A tool that replaces its
  own definition later (a new object, not a mutation) keeps executing the
  captured version for agents that already existed; recreate the agent to pick up
  the new definition. A tool that registers **after** the agent exists is still
  clamped: the registry's `tools/change` notification triggers a re-scan.
- Approval policy is read as `ask` when the approval seam is composed, even if no
  answerer is present; such a session keeps the parameters and fails closed at
  approval time, as DSH documents.
- The shadow is an agent-scoped registration, so it shadows the inherited tool for
  that agent only and disappears with the agent or when the plugin unloads.

## Tests

```
node --test
```

The suite drives the plugin through a registry stub that mirrors scoped shadowing
and `tools/change`, covering discovery, repair, dynamic policy switches,
late-registered capabilities, `exclude`, and unload.
