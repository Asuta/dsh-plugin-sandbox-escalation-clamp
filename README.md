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

DSH resolves the tool first. The plugin adapts the resulting definition for the
model and for dispatch, preserving the original registration, activation
condition, scope restrictions, and lifetime. This also covers tools installed
while a session is open.

- **Hide** — omit the pair from the model schema when the session cannot
  escalate. The next schema projection reads the current session policy.
- **Repair** — remove stale or malformed escalation fields before the original
  tool validates its arguments. The original tool still enforces the session's
  standing permissions. A valid request for a wider mode with approvals enabled
  reaches the original tool unchanged.
- **Explain** — add targeted guidance to structured escalation argument errors.
  An actual filesystem denial retains its error code and denial text. The
  upgrade hint is removed when escalation is unavailable.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `discover` | `true` | Include visible tools that declare both optional DSH escalation fields and the recognized target enum |
| `tools` | `[]` | Select tool names when `discover` is `false`. Each still needs the DSH escalation fields |
| `exclude` | `[]` | Exclude these tools from schema, argument, and error changes |
| `hideEscalationFields` | `true` | Omit the pair from the model schema when escalation is unavailable |
| `repairCalls` | `true` | Remove stale or malformed escalation fields before validation |
| `explainErrors` | `true` | Clarify escalation argument errors and suppress impossible escalation hints on filesystem denials |

## Toggle

Disable the plugin in **Plugins** to restore the stock schemas and tool behavior
for the profile. Re-enable it to apply the clamp again.

## Compatibility

- The adapter uses the Cordis service instance and the two lookup methods of
  ToolsService verified in DSH `0.2.2-rc.5`. If those methods cannot be wrapped,
  the plugin logs a warning and leaves the stock tools in place.
- PTC's registered tools use those lookup methods. The executor owns the reserved
  `run_code` transport separately, and its own schema and calls are unaffected.
- A composed approval service can report `ask` with no answerer. The stock tool
  handles approval in that case.

## Tests

Run `node --test` from the package directory. To also exercise the installed DSH
ToolsService and Cordis runtime, run the same suite using the ASAR-aware Desktop
runtime with `DSH_CLAMP_INTEGRATION=1` and `DSH_INSTALL_DIR` pointing to the
installed CLI package. The integration uses a separate in-memory context.
