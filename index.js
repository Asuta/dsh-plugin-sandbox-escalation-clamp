/**
 * Sandbox escalation clamp.
 *
 * A session whose sandbox policy can never be widened still receives the
 * `sandbox_permissions` + `justification` parameters of every confining tool.
 * Which tools carry them is decided by the mounted capabilities, not by this
 * plugin: with both a confining filesystem and a confining shell the pair is
 * advertised on `write`, `edit`, `pwsh` and `bash` alike. A model that fills
 * those parameters anyway is rejected inside the tool body — the failure mode
 * observed in session-400b8db7 (22 identical `pwsh` calls dying on
 * `invalid justification: expected a non-empty sentence`) repeated in
 * session-ba3291a0 on `write`, because an earlier version clamped only the
 * tools named in its own configuration.
 *
 * This plugin removes that trap for the agents that cannot escalate:
 *
 * - Hide: an agent-scoped shadow definition whose `parameters` never advertise
 *   the escalation pair while the session cannot widen (approval policy `never`,
 *   or standing mode already `danger-full-access`). A session that can still
 *   escalate keeps the stock schema, so legitimate escalation is untouched.
 * - Repair: the shadow delegates execution to the inherited tool definition after
 *   dropping escalation arguments that cannot produce a grant, so the command
 *   runs instead of failing validation.
 * - Explain: a remaining escalation error is rewritten into one actionable
 *   instruction naming the tool and the exact fix.
 *
 * The clamp discovers its targets instead of trusting a hand-maintained list:
 * every tool the agent resolves that advertises either escalation parameter is
 * shadowed, and the registry's `tools/change` notification re-scans after a
 * capability registers late, so a tool mounted after the agent was created is
 * still covered from the next step onward.
 *
 * Tools resolve from the preset or global scope the agent inherits, so the
 * definition is captured once per agent; the schema getter still re-evaluates
 * the session's current policy on every projection.
 *
 * @module @local/dsh-plugin-sandbox-escalation-clamp
 */

export const name = 'sandbox-escalation-clamp'


/** The tool registry is the only required service; approvals and policy are optional. */
export const inject = ['tools']

/** The escalation pair travels together; both are withdrawn or repaired as a unit. */
const ESCALATION_KEYS = ['sandbox_permissions', 'justification']

/** The closed strictly-wider ladder, mirroring `@deepseek-ai/dsh-sandbox`. */
const WIDER_MODES = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
  'danger-full-access': [],
}

/**
 * Names that can never be shadowed. `run_code` is the reserved PTC transport:
 * the registry rejects any registration of that name, and the nested calls it
 * dispatches are clamped by the tools they reach, not by the transport.
 */
const RESERVED_TOOL_NAMES = new Set(['run_code'])

/**
 * Configuration keys consumed by {@link apply}. Declared here for readers only:
 * the bundle exports no `Config` schema, so no package import is required at
 * load time and the row's `config` reaches `apply` as written.
 *
 * `discover` (default `true`) is what keeps the clamp complete: it shadows every
 * tool that advertises the escalation pair rather than the names listed in
 * `tools`. Set it to `false` together with an explicit `tools` list only to
 * clamp a fixed subset.
 */
export const CONFIG_KEYS = Object.freeze({
  discover: true,
  tools: [],
  exclude: [],
  hideEscalationFields: true,
  repairCalls: true,
  explainErrors: true,
})

/**
 * The session's effective approval policy.
 * @param ctx - plugin context.
 * @param session - the calling agent's session.
 * @returns `ask` or `never`; a composition without the approval seam can never grant.
 */
function approvalPolicyOf(ctx, session) {
  const approval = ctx.get('approval')
  if (approval === undefined) return 'never'
  const override = typeof approval.overrideOf === 'function' ? approval.overrideOf(session) : undefined
  return override ?? approval.config?.policy ?? 'ask'
}

/**
 * The session's standing file-effect mode.
 * @param ctx - plugin context.
 * @param session - the calling agent's session.
 * @returns the resolved mode, or undefined when no policy service is composed.
 */
function standingModeOf(ctx, session) {
  const policy = ctx.get('sandboxPolicy')
  if (policy === undefined || typeof policy.resolve !== 'function') return undefined
  try {
    return policy.resolve({ session })?.mode
  } catch {
    return undefined
  }
}

/**
 * Why this session cannot escalate, if it cannot.
 * @param ctx - plugin context.
 * @param session - the calling agent's session.
 * @returns a stable reason tag, or undefined when a wider mode is still reachable.
 */
function escalatesNowhere(ctx, session) {
  const mode = standingModeOf(ctx, session)
  if (mode === undefined) return undefined
  if (mode === 'danger-full-access') return 'session-already-full-access'
  if (approvalPolicyOf(ctx, session) === 'never') return 'approval-policy-never'
  return undefined
}

/**
 * Whether a parameter schema advertises the escalation pair.
 * @param parameters - tool parameter schema.
 * @returns true when either escalation key is declared.
 */
function advertisesEscalation(parameters) {
  const properties = parameters?.properties
  if (properties === null || typeof properties !== 'object') return false
  return ESCALATION_KEYS.some(key => Object.prototype.hasOwnProperty.call(properties, key))
}

/**
 * Copy a parameter schema without the escalation pair.
 * @param parameters - tool parameter schema.
 * @returns the stripped copy; the input is never mutated.
 */
function withoutEscalationFields(parameters) {
  if (parameters === null || typeof parameters !== 'object') return parameters
  const copy = structuredClone(parameters)
  const properties = copy.properties
  if (properties !== null && typeof properties === 'object') {
    for (const key of ESCALATION_KEYS) delete properties[key]
  }
  if (Array.isArray(copy.required)) {
    copy.required = copy.required.filter(entry => !ESCALATION_KEYS.includes(entry))
    if (copy.required.length === 0) delete copy.required
  }
  return copy
}

/**
 * Drop escalation arguments that cannot produce a grant.
 *
 * The tools validate the pair inside their own `execute` (the sandbox escalation
 * helper throws `SandboxEscalationError` before the mutation or command runs),
 * so rewriting the arguments before delegating is enough to let the call
 * succeed; the model-facing schema is what keeps the pair from being sent at
 * all.
 *
 * @param ctx - plugin context.
 * @param session - the calling agent's session.
 * @param args - parsed model arguments.
 * @returns the original arguments, or a copy without the escalation pair.
 */
function clampArguments(ctx, session, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const hasPermissions = Object.prototype.hasOwnProperty.call(args, 'sandbox_permissions')
  const hasJustification = Object.prototype.hasOwnProperty.call(args, 'justification')
  if (!hasPermissions && !hasJustification) return args
  const blocked = escalatesNowhere(ctx, session) !== undefined
  const mode = standingModeOf(ctx, session)
  const widens = hasPermissions && (WIDER_MODES[mode] ?? []).includes(args.sandbox_permissions)
  const justified = typeof args.justification === 'string' && args.justification.trim() !== ''
  if (!blocked && hasPermissions && widens && justified) return args
  const cleaned = { ...args }
  delete cleaned.sandbox_permissions
  delete cleaned.justification
  return cleaned
}

/**
 * Build the agent-scoped shadow definition.
 *
 * The inherited definition is captured once: tool plugins resolve from the
 * preset/global scope, whose registrations are final by `agent/created`, and an
 * agent-scoped shadow hides the inherited entry from further lookup. Every other
 * field is copied as-is so presentation, timeout, and safety classification keep
 * behaving exactly like the inherited tool.
 *
 * @param ctx - plugin context.
 * @param agent - the agent that owns the shadow.
 * @param definition - the definition this agent currently resolves.
 * @param settings - resolved plugin configuration.
 * @returns a definition that delegates to the captured definition.
 */
function createShadow(ctx, agent, definition, settings) {
  const shadow = { ...definition }
  Object.defineProperties(shadow, {
    description: { enumerable: true, configurable: true, get: () => definition.description },
    parameters: {
      enumerable: true,
      configurable: true,
      get: () => {
        const hide = settings.hideEscalationFields && escalatesNowhere(ctx, agent.session) !== undefined
        return hide ? withoutEscalationFields(definition.parameters) : definition.parameters
      },
    },
  })
  shadow.execute = async (args, exec) => {
    const cleaned = settings.repairCalls ? clampArguments(ctx, agent.session, args) : args
    return definition.execute(cleaned, exec)
  }
  return shadow
}

/** Concatenate the text of model-facing content blocks. */
function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

/** Whether the recorded arguments asked for escalation. */
function carriesEscalation(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false
  return ESCALATION_KEYS.some(key => Object.prototype.hasOwnProperty.call(args, key))
}

/**
 * The actionable rewrite of a refused escalation.
 * @param reason - why the session cannot widen, if it cannot.
 * @param mode - the standing mode, when known.
 * @param original - the original model-facing error text.
 * @param toolName - the tool whose call was refused.
 * @returns replacement text for the tool result.
 */
function explanation(reason, mode, original, toolName) {
  const why = reason === 'session-already-full-access'
    ? 'this session already runs at `danger-full-access`, so there is no wider mode to request'
    : reason === 'approval-policy-never'
      ? 'approvals are disabled in this session, so an escalation can never be granted'
      : `\`sandbox_permissions\` must name a strictly wider mode than the standing "${mode ?? 'current'}" mode`
  return `${original}\n\n`
    + `The ${toolName ?? 'tool'} call did not run. Re-issue the identical call without `
    + `\`sandbox_permissions\` and \`justification\`; ${why}.`
}

/**
 * Mount the clamp.
 * @param ctx - plugin context.
 * @param config - row configuration from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const settings = {
    discover: config.discover ?? true,
    tools: [...new Set(Array.isArray(config.tools) ? config.tools.filter(entry => typeof entry === 'string') : [])],
    exclude: new Set(Array.isArray(config.exclude) ? config.exclude.filter(entry => typeof entry === 'string') : []),
    hideEscalationFields: config.hideEscalationFields ?? true,
    repairCalls: config.repairCalls ?? true,
    explainErrors: config.explainErrors ?? true,
  }
  /** Per-agent shadow sets, keyed by the agent whose scope owns them. */
  const records = new Map()
  let active = true
  /** Re-entrancy guard: our own registrations emit `tools/change`. */
  let scanning = false
  /** A registry change that arrived while scanning; re-run once instead of recursing. */
  let rescan = false

  const liveAgents = () => [...(ctx.get('agents')?.list?.() ?? [])]

  const recordFor = agent => {
    const existing = records.get(agent)
    if (existing !== undefined) return existing
    const record = {
      names: new Set(),
      disposers: [],
      /** Disposers for this agent's shadows, in registration order. */
      disposeAll: () => { for (const disposer of record.disposers.splice(0)) disposer() },
      /** Agent-scoped effect that tears the record down with the agent. */
      owned: undefined,
    }
    records.set(agent, record)
    return record
  }

  const installShadow = (agent, record, toolName) => {
    if (RESERVED_TOOL_NAMES.has(toolName) || settings.exclude.has(toolName) || record.names.has(toolName)) return
    const definition = ctx.tools.get(toolName, agent)
    if (definition === undefined || !advertisesEscalation(definition.parameters)) return
    // Claim the name before registering: `register` emits `tools/change`
    // synchronously, and the re-entrant scan must see the claim as final.
    record.names.add(toolName)
    try {
      if (record.owned === undefined) {
        record.owned = agent.ctx.effect(() => () => {
          records.delete(agent)
          record.disposeAll()
        }, 'sandbox-escalation-clamp: agent shadow')
      }
      record.disposers.push(agent.ctx.tools.register(createShadow(ctx, agent, definition, settings)))
    } catch (error) {
      record.names.delete(toolName)
      ctx.logger?.warn?.(`sandbox-escalation-clamp: cannot shadow "${toolName}": ${String(error)}`)
    }
  }

  const clampAgent = agent => {
    if (!active) return
    const record = recordFor(agent)
    for (const toolName of settings.tools) installShadow(agent, record, toolName)
    if (!settings.discover) return
    for (const definition of ctx.tools.definitions(agent) ?? []) installShadow(agent, record, definition.name)
  }

  const scanAll = () => {
    if (!active) return
    if (scanning) {
      rescan = true
      return
    }
    scanning = true
    try {
      do {
        rescan = false
        for (const agent of liveAgents()) clampAgent(agent)
      } while (rescan && active)
    } finally {
      scanning = false
    }
  }

  const disposeShadow = agent => {
    const record = records.get(agent)
    if (record === undefined) return
    records.delete(agent)
    record.disposeAll()
    record.owned?.()
  }

  ctx.effect(() => () => {
    active = false
    for (const agent of [...records.keys()]) disposeShadow(agent)
  }, 'sandbox-escalation-clamp')

  ctx.on('agent/created', ({ agent }) => { clampAgent(agent) })
  ctx.on('agent/disposed', ({ agent }) => { disposeShadow(agent) })

  // A capability that registers after the agent exists (or a session-visible
  // variant replacing a definition) is picked up here rather than at creation.
  ctx.on('tools/change', () => { scanAll() })

  for (const agent of liveAgents()) clampAgent(agent)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!settings.explainErrors || decision.kind !== 'accept' || result.isError !== true) return decision
    if (!carriesEscalation(exec.arguments)) return decision
    const text = contentText(decision.content ?? result.content)
    if (!/sandbox_permissions|invalid justification|sandbox escalation/i.test(text)) return decision
    const reason = exec.agent === undefined ? undefined : escalatesNowhere(ctx, exec.agent.session)
    const mode = exec.agent === undefined ? undefined : standingModeOf(ctx, exec.agent.session)
    return {
      kind: 'block',
      feedback: [{ type: 'text', text: explanation(reason, mode, text, exec.name) }],
      ...result.error?.info !== undefined ? { info: result.error.info } : {},
    }
  })
}
