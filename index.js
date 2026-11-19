/**
 * Sandbox escalation clamp.
 *
 * A session whose sandbox policy can never be widened still receives the
 * `sandbox_permissions` + `justification` parameters of every confining tool
 * (pwsh, bash, write, edit). A model that fills those parameters anyway is
 * rejected by argument validation before the command runs — the failure mode
 * observed in session-400b8db7, where 22 identical `pwsh` calls all died on
 * `invalid justification: expected a non-empty sentence`.
 *
 * This plugin removes that trap for the agents that cannot escalate:
 *
 * - Hide: an agent-scoped shadow definition whose `parameters` never advertise
 *   the escalation pair while the session cannot widen (approval policy `never`,
 *   or standing mode already `danger-full-access`).
 * - Repair: the shadow delegates execution to the inherited tool definition after
 *   dropping escalation arguments that cannot produce a grant, so the command
 *   runs instead of failing validation.
 * - Explain: a remaining escalation error is rewritten into one actionable
 *   instruction naming the exact fix.
 *
 * Tools resolve from the preset or global scope the agent inherits, so the
 * definition is captured once per agent at `agent/created`; the schema getter
 * still re-evaluates the session's current policy on every projection.
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
 * Configuration keys consumed by {@link apply}. Declared here for readers only:
 * the bundle exports no `Config` schema, so no package import is required at
 * load time and the row's `config` reaches `apply` as written.
 */
export const CONFIG_KEYS = Object.freeze({
  hideEscalationFields: true,
  repairCalls: true,
  explainErrors: true,
  tools: ['pwsh', 'bash'],
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
 * agent-scoped shadow hides the inherited entry from further lookup.
 *
 * @param ctx - plugin context.
 * @param agent - the agent that owns the shadow.
 * @param toolName - registered tool name.
 * @param definition - the definition this agent currently resolves.
 * @param settings - resolved plugin configuration.
 * @returns a definition that delegates to the captured definition.
 */
function createShadow(ctx, agent, toolName, definition, settings) {
  const shadow = { name: definition.name, output: definition.output }
  for (const key of ['deferLoading', 'timeoutMs', 'isConcurrencySafe', 'presentCall', 'presentResult', 'projectContent', 'finalizeContent']) {
    if (definition[key] !== undefined) shadow[key] = definition[key]
  }
  Object.defineProperties(shadow, {
    description: { enumerable: true, get: () => definition.description },
    parameters: {
      enumerable: true,
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
 * @returns replacement text for the tool result.
 */
function explanation(reason, mode, original) {
  const why = reason === 'session-already-full-access'
    ? 'this session already runs at `danger-full-access`, so there is no wider mode to request'
    : reason === 'approval-policy-never'
      ? 'approvals are disabled in this session, so an escalation can never be granted'
      : `\`sandbox_permissions\` must name a strictly wider mode than the standing "${mode ?? 'current'}" mode`
  return `${original}\n\n`
    + `Remove \`sandbox_permissions\` and \`justification\` from the arguments and issue the identical call again; ${why}.`
}

/**
 * Mount the clamp.
 * @param ctx - plugin context.
 * @param config - row configuration from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const settings = {
    hideEscalationFields: config.hideEscalationFields ?? true,
    repairCalls: config.repairCalls ?? true,
    explainErrors: config.explainErrors ?? true,
    tools: config.tools ?? ['pwsh', 'bash'],
  }
  const shadows = new Map()
  let active = true

  const disposeShadow = agent => {
    const record = shadows.get(agent)
    if (record === undefined) return
    shadows.delete(agent)
    record.disposeAll()
    record.owned()
  }

  const install = agent => {
    if (!active || shadows.has(agent)) return
    const names = [...new Set(settings.tools)].filter(toolName => toolName !== 'run_code')
    const disposers = []
    for (const toolName of names) {
      const definition = ctx.tools.get(toolName, agent)
      if (definition === undefined || !advertisesEscalation(definition.parameters)) continue
      try {
        disposers.push(agent.ctx.tools.register(createShadow(ctx, agent, toolName, definition, settings)))
      } catch (error) {
        ctx.logger?.warn?.(`sandbox-escalation-clamp: cannot shadow "${toolName}": ${String(error)}`)
      }
    }
    if (disposers.length === 0) return
    const record = { disposeAll: () => { for (const disposer of disposers.splice(0)) disposer() } }
    record.owned = agent.ctx.effect(() => () => record.disposeAll(), 'sandbox-escalation-clamp: agent shadow')
    shadows.set(agent, record)
  }

  ctx.effect(() => () => {
    active = false
    for (const agent of [...shadows.keys()]) disposeShadow(agent)
  }, 'sandbox-escalation-clamp')

  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => { disposeShadow(agent) })

  for (const agent of ctx.get('agents')?.list?.() ?? []) install(agent)

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
      feedback: [{ type: 'text', text: explanation(reason, mode, text) }],
      ...result.error?.info !== undefined ? { info: result.error.info } : {},
    }
  })
}
