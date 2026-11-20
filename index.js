/** Clamp DSH one-shot escalation fields after the registry resolves a tool. */
export const name = 'sandbox-escalation-clamp'
export const inject = ['tools']

const ORIGINAL_SERVICE = Symbol.for('cordis.original')
const ESCALATION_KEYS = ['sandbox_permissions', 'justification']
const ESCALATION_TARGETS = ['workspace-write', 'danger-full-access']
const WIDER_MODES = new Map([
  ['read-only', ESCALATION_TARGETS],
  ['workspace-write', ['danger-full-access']],
  ['danger-full-access', []],
])
const ESCALATION_HINT = /^\[sandbox: escalation available — retry this exact (?:operation|command) once with sandbox_permissions .*\]$/
const FORWARDED_TOOL_FIELDS = [
  'name', 'description', 'output', 'deferLoading', 'timeoutMs', 'isConcurrencySafe',
  'presentCall', 'presentResult', 'projectContent', 'finalizeContent',
]

export const CONFIG_KEYS = Object.freeze({
  discover: true,
  tools: [],
  exclude: [],
  hideEscalationFields: true,
  repairCalls: true,
  explainErrors: true,
})

function sandboxState(ctx, session) {
  try {
    const mode = ctx.get('sandboxPolicy')?.resolve({ session })?.mode
    if (!WIDER_MODES.has(mode)) return undefined
    if (mode === 'danger-full-access') return { mode, cannotEscalate: 'this session already has full sandbox access' }
    const approval = ctx.get('approval')
    const policy = approval?.overrideOf?.(session) ?? approval?.config?.policy ?? 'ask'
    if (approval === undefined || policy === 'never') {
      return { mode, cannotEscalate: 'sandbox escalation approval is unavailable in this session' }
    }
    if (policy === 'ask') return { mode }
  } catch {
    // Leave the stock tool in charge if its policy cannot be determined.
  }
  return undefined
}

/** Identify the optional DSH pair, including its closed sandbox target enum. */
function advertisesEscalation(parameters) {
  const properties = parameters?.properties
  if (properties == null || !ESCALATION_KEYS.every(key => Object.hasOwn(properties, key))) return false
  if (parameters.required !== undefined && (!Array.isArray(parameters.required)
    || ESCALATION_KEYS.some(key => parameters.required.includes(key)))) return false
  const { sandbox_permissions: permission, justification } = properties
  return permission?.type === 'string' && justification?.type === 'string'
    && Array.isArray(permission.enum) && permission.enum.length > 0
    && permission.enum.every(value => ESCALATION_TARGETS.includes(value))
}

function withoutEscalationFields(parameters) {
  const properties = { ...parameters.properties }
  for (const key of ESCALATION_KEYS) delete properties[key]
  return { ...parameters, properties }
}

function carriesEscalation(args) {
  return args !== null && typeof args === 'object' && !Array.isArray(args)
    && ESCALATION_KEYS.some(key => Object.hasOwn(args, key))
}

function clampArguments(ctx, session, args) {
  if (!carriesEscalation(args)) return args
  const state = sandboxState(ctx, session)
  if (state === undefined) return args
  const widens = Object.hasOwn(args, 'sandbox_permissions') && WIDER_MODES.get(state.mode).includes(args.sandbox_permissions)
  const justified = Object.hasOwn(args, 'justification')
    && typeof args.justification === 'string' && args.justification.trim() !== ''
  if (!state.cannotEscalate && widens && justified) return args
  const cleaned = { ...args }
  for (const key of ESCALATION_KEYS) delete cleaned[key]
  return Object.freeze(cleaned)
}

/** A temporary view of an admitted definition, never a registry contribution. */
function wrapDefinition(definition, parameters, execute) {
  const wrapped = { parameters, execute }
  for (const key of FORWARDED_TOOL_FIELDS) {
    Object.defineProperty(wrapped, key, {
      enumerable: true,
      get() {
        const value = definition[key]
        return typeof value === 'function' ? value.bind(definition) : value
      },
    })
  }
  return wrapped
}

/** Wrap the two output boundaries without changing resolve(), get(), or step admission. */
function wrapLookups(registry, wrappers) {
  const restore = []
  try {
    for (const [method, wrap] of Object.entries(wrappers)) {
      const own = Object.getOwnPropertyDescriptor(registry, method)
      const original = registry[method]
      if (typeof original !== 'function') throw new TypeError(`ToolsService.${method} is unavailable`)
      const replacement = function (...args) {
        const value = Reflect.apply(original, this, args)
        return wrap(value, args)
      }
      Object.defineProperty(registry, method, {
        value: replacement, configurable: true, writable: true, enumerable: own?.enumerable ?? false,
      })
      restore.push(() => {
        if (Object.getOwnPropertyDescriptor(registry, method)?.value !== replacement) return
        if (own === undefined) delete registry[method]
        else Object.defineProperty(registry, method, own)
      })
    }
  } catch (error) {
    for (const undo of restore.reverse()) undo()
    throw error
  }
  return () => { for (const undo of restore.reverse()) undo() }
}

function stringNames(value) {
  return new Set(Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : [])
}

function stripEscalationHint(text) {
  return text.split(/\r?\n/).filter(line => !ESCALATION_HINT.test(line)).join('\n')
}

function explainFailure(ctx, exec, result) {
  if (!result.isError) return result
  const { code } = result.error.info ?? {}
  if (code === 'FS_SANDBOX_DENIED' && sandboxState(ctx, exec.agent.session)?.cannotEscalate) {
    const { message } = result.error
    const cleanedMessage = stripEscalationHint(message)
    const content = result.content.map(block => block.type === 'text'
      ? { ...block, text: stripEscalationHint(block.text) }
      : block)
    return { ...result, error: { ...result.error, message: cleanedMessage }, content }
  }
  if (code !== 'SANDBOX_ESCALATION_INVALID_ARGUMENT' || !carriesEscalation(exec.arguments)) return result
  const state = sandboxState(ctx, exec.agent.session)
  const advice = state?.cannotEscalate
    ? `Retry without sandbox_permissions and justification if the operation is still needed. ${state.cannotEscalate}.`
    : 'For a normal call, omit sandbox_permissions and justification. For an approved retry of a sandbox-denied operation, request a strictly wider mode and include a non-empty justification.'
  return {
    ...result,
    error: { ...result.error, message: `${result.error.message}\n\n${advice}` },
    content: [...result.content, { type: 'text', text: advice }],
  }
}

export function apply(ctx, config = {}) {
  const settings = { ...CONFIG_KEYS, ...config }
  const tools = stringNames(settings.tools)
  const exclude = stringNames(settings.exclude)
  const matches = definition => definition !== undefined && definition.name !== 'run_code'
    && !exclude.has(definition.name) && (settings.discover || tools.has(definition.name))
    && advertisesEscalation(definition.parameters)

  const service = ctx.tools
  const registry = service[ORIGINAL_SERVICE] ?? service
  const originalExecutable = registry.executable
  let active = false

  ctx.effect(() => {
    let restore
    try {
      restore = wrapLookups(registry, {
        definitions(definitions, [scope]) {
          if (!active || !settings.hideEscalationFields || scope?.session === undefined
            || !sandboxState(ctx, scope.session)?.cannotEscalate) return definitions
          return definitions.map(definition => matches(definition)
            ? wrapDefinition(definition, withoutEscalationFields(definition.parameters), definition.execute.bind(definition))
            : definition)
        },
        executable(definition, [, scope]) {
          if (!active || !settings.repairCalls || scope?.session === undefined || !matches(definition)) return definition
          return wrapDefinition(definition, definition.parameters, (args, exec) => {
            const cleaned = active && exec.agent === scope ? clampArguments(ctx, scope.session, args) : args
            return definition.execute(cleaned, exec)
          })
        },
      })
      active = true
    } catch (error) {
      ctx.logger?.warn?.(`sandbox-escalation-clamp: incompatible tools service: ${String(error)}`)
    }
    return () => {
      active = false
      restore?.()
    }
  }, 'sandbox-escalation-clamp: tool lookup adapter')

  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (!active || !settings.explainErrors || !result.isError || exec.agent === undefined) return result
    const definition = Reflect.apply(originalExecutable, registry, [exec.name, exec.agent, exec.toolSet])
    return matches(definition) ? explainFailure(ctx, exec, result) : result
  })
}
