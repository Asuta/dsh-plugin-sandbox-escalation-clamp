# Sandbox escalation clamp

Withdraws the `sandbox_permissions` + `justification` pair from the model-facing
schema of confining tools, and repairs escalation arguments that cannot produce a
grant, for every agent whose session can never widen its sandbox.

## Why

DSH advertises those two parameters on tools such as `pwsh` and `bash` whenever a
confining executor is mounted. They are only meaningful for one-shot escalation:
`approval = never`, or a session already at `danger-full-access`, can never grant
one. A model that fills them anyway is refused by argument validation before the
command runs:

```
Error: invalid justification: expected a non-empty sentence
Error: sandbox escalation to "workspace-write" is not strictly wider than this call's current "danger-full-access" mode
```

A model that keeps re-emitting the same parameter then loops until the turn is
aborted. This plugin removes the trap instead of relying on the model to recover.

## What it does

For each agent (including agents that already existed when the plugin loaded), it
registers an agent-scoped shadow of every configured tool that advertises the pair:

- **Hide** — the shadow's `parameters` omit `sandbox_permissions` and
  `justification` while the session cannot escalate. The getter re-evaluates the
  session's approval policy and standing mode on every schema projection, so a
  mid-session policy switch is honored without re-registering.
- **Repair** — the shadow delegates execution to the inherited tool definition
  after dropping escalation arguments that cannot produce a grant: the session
  already cannot widen, the requested mode is not strictly wider than the
  standing mode, or the justification is blank. The command then runs normally.
- **Explain** — an escalation error that still reaches the model is rewritten into
  the original message plus one instruction: drop `sandbox_permissions` and
  `justification` and re-issue the identical call.

Legitimate escalation is untouched: when the session is confined below
`danger-full-access` and approvals are `ask`, a strictly wider request with a
non-empty justification passes through unchanged.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `hideEscalationFields` | `true` | Remove the escalation pair from the shadow's schema while the session cannot escalate |
| `repairCalls` | `true` | Drop escalation arguments that cannot produce a grant before the tool runs |
| `explainErrors` | `true` | Append the actionable instruction to a remaining escalation error |
| `tools` | `["pwsh","bash"]` | Tool names to clamp; `run_code` is always skipped |

Add `write` and `edit` to `tools` to clamp the filesystem tools as well. The
plugin never changes a tool's own behaviour beyond the escalation arguments.

## Toggle

The capability lives entirely in this bundle. Disable its row in **Plugins** to
remove the shadows and restore the stock schemas and messages for every session;
re-enable to install them again. Turn it off when a session genuinely relies on
escalation prompts and you want the model to see the parameters.

## Limits

- Only the tools named in `tools` are clamped; a tool registered after an agent
  was created is not shadowed for that agent until the agent is recreated (the
  `explainErrors` rewrite still applies).
- The inherited definition is captured once per agent, because an agent-scoped
  shadow hides the inherited entry from further lookup. A tool that replaces its
  own definition later (a new object, not a mutation) keeps executing the
  captured version for agents that already existed; recreate the agent to pick
  up the new definition.
- Approval policy is read as `ask` when the approval seam is composed, even if no
  answerer is present; such a session keeps the parameters and fails closed at
  approval time, as DSH documents.
- The shadow is an agent-scoped registration, so it shadows the inherited tool for
  that agent only and disappears with the agent or when the plugin unloads.
