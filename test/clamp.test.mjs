/**
 * Behavioural tests for the escalation clamp, driven through a registry stub
 * that mirrors the parts of `ctx.tools` the plugin uses: scoped shadowing
 * (`get`/`definitions`), a synchronous `tools/change` notification, and the
 * agent-scoped `register` that installs a shadow.
 *
 * Run with `node --test` from the package root.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'

/** The escalation pair a confining capability advertises. */
const PAIR = {
  sandbox_permissions: {
    type: 'string',
    enum: ['workspace-write', 'danger-full-access'],
    description: 'wider mode',
  },
  justification: { type: 'string', description: 'why' },
}

/**
 * One tool definition shaped like `defineTool` output: schema plus an execute
 * that records what it received.
 */
function tool(name, parameters, { pair = true, value } = {}) {
  const definition = {
    name,
    description: `${name} tool`,
    parameters: pair
      ? { type: 'object', properties: { ...parameters, ...PAIR } }
      : { type: 'object', properties: parameters },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    seen: [],
    async execute(args) {
      definition.seen.push(args)
      return value ?? { ok: true }
    },
  }
  return definition
}

/** A tool registry stub with global and per-agent scopes. */
class Registry {
  constructor() {
    this.global = new Map()
    this.scoped = new Map()
    this.listeners = []
  }

  onChange(listener) { this.listeners.push(listener) }

  changed() { for (const listener of [...this.listeners]) listener() }

  table(scope) {
    if (scope === undefined) return this.global
    let table = this.scoped.get(scope)
    if (table === undefined) {
      table = new Map()
      this.scoped.set(scope, table)
    }
    return table
  }

  registerFor(scope, definition) {
    const table = this.table(scope)
    if (table.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
    table.set(definition.name, definition)
    this.changed()
    return () => {
      table.delete(definition.name)
      this.changed()
    }
  }

  visible(scope) {
    const map = new Map(this.global)
    for (const [name, definition] of this.scoped.get(scope) ?? []) map.set(name, definition)
    return map
  }

  get(name, scope) { return this.visible(scope).get(name) }

  definitions(scope) { return [...this.visible(scope).values()] }

  register(definition) { return this.registerFor(undefined, definition) }
}

/** A plugin context stub with the services the clamp consults. */
function harness({ mode = 'danger-full-access', policy = 'never', modeAbsent = false } = {}) {
  const registry = new Registry()
  const handlers = new Map()
  const agents = []
  const state = { mode, policy }
  const ctx = {
    tools: registry,
    logger: { warn() {} },
    get(name) {
      if (name === 'agents') return { list: () => agents }
      if (name === 'approval') {
        return state.policy === null
          ? undefined
          : { overrideOf: () => undefined, config: { policy: state.policy } }
      }
      if (name === 'sandboxPolicy') {
        return modeAbsent || state.mode === null ? undefined : { resolve: () => ({ mode: state.mode }) }
      }
      return undefined
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    emit(event, payload) { for (const handler of handlers.get(event) ?? []) handler(payload) },
    effect(fn) { return fn() },
  }
  registry.onChange(() => ctx.emit('tools/change'))
  const agent = {
    name: 'lead',
    session: { id: 'session-test' },
    ctx: {
      tools: { register: definition => registry.registerFor(agent, definition) },
      effect: fn => fn(),
    },
  }
  agents.push(agent)
  return { ctx, registry, agent, agents, state, handlers }
}

/** The escalation pair still advertised by a tool as one agent sees it. */
function advertises(registry, agent, name) {
  const definition = registry.get(name, agent)
  assert.ok(definition !== undefined, `${name} must resolve`)
  const properties = definition.parameters?.properties ?? {}
  return Object.prototype.hasOwnProperty.call(properties, 'sandbox_permissions')
    || Object.prototype.hasOwnProperty.call(properties, 'justification')
}

test('discovers every tool that advertises the pair, not just the configured names', () => {
  const { ctx, registry, agent } = harness()
  registry.registerFor(undefined, tool('write', { file_path: { type: 'string' }, content: { type: 'string' } }))
  registry.registerFor(undefined, tool('edit', { file_path: { type: 'string' } }))
  registry.registerFor(undefined, tool('pwsh', { command: { type: 'string' } }))
  registry.registerFor(undefined, tool('read', { file_path: { type: 'string' } }, { pair: false }))

  apply(ctx, {})

  for (const name of ['write', 'edit', 'pwsh']) {
    assert.equal(advertises(registry, agent, name), false, `${name} must be clamped`)
  }
  // A tool without the pair keeps the exact registered definition.
  assert.equal(registry.get('read', agent).description, 'read tool')
  assert.equal(advertises(registry, agent, 'read'), false)
})

test('repairs escalation arguments before the tool body validates them', async () => {
  const { ctx, registry, agent } = harness()
  const write = tool('write', { file_path: { type: 'string' } })
  registry.registerFor(undefined, write)

  apply(ctx, {})

  const args = { file_path: 'a.txt', content: 'x', sandbox_permissions: 'workspace-write', justification: '' }
  const result = await registry.get('write', agent).execute(args, {})

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(write.seen.at(-1), { file_path: 'a.txt', content: 'x' })
  // The caller's object is never mutated.
  assert.equal(args.sandbox_permissions, 'workspace-write')
})

test('leaves a session that can still escalate untouched', async () => {
  const { ctx, registry, agent, state } = harness({ mode: 'read-only', policy: 'ask' })
  const write = tool('write', { file_path: { type: 'string' } })
  registry.registerFor(undefined, write)

  apply(ctx, {})

  assert.equal(advertises(registry, agent, 'write'), true)

  const sanctioned = { file_path: 'a.txt', sandbox_permissions: 'workspace-write', justification: 'needs the parent dir' }
  await registry.get('write', agent).execute(sanctioned, {})
  assert.deepEqual(write.seen.at(-1), sanctioned, 'a strictly wider justified request passes through')

  // A blank justification cannot grant, so the pair is dropped instead of failing validation.
  await registry.get('write', agent).execute({ file_path: 'a.txt', sandbox_permissions: 'workspace-write', justification: ' ' }, {})
  assert.deepEqual(write.seen.at(-1), { file_path: 'a.txt' })

  // The schema follows a mid-session policy switch without re-registering.
  state.policy = 'never'
  assert.equal(advertises(registry, agent, 'write'), false)
})

test('clamps a capability that registers after the agent was created', () => {
  const { ctx, registry, agent } = harness()
  registry.registerFor(undefined, tool('pwsh', { command: { type: 'string' } }))
  apply(ctx, {})

  const late = tool('apply_patch', { patch: { type: 'string' } })
  registry.registerFor(undefined, late)

  assert.equal(advertises(registry, agent, 'apply_patch'), false)
  assert.notEqual(registry.get('apply_patch', agent), late)
})

test('discover: false clamps only the configured tools', () => {
  const { ctx, registry, agent } = harness()
  registry.registerFor(undefined, tool('write', { file_path: { type: 'string' } }))
  registry.registerFor(undefined, tool('pwsh', { command: { type: 'string' } }))

  apply(ctx, { discover: false, tools: ['pwsh'] })

  assert.equal(advertises(registry, agent, 'pwsh'), false)
  assert.equal(advertises(registry, agent, 'write'), true)
})

test('exclude keeps a named tool out of the clamp', () => {
  const { ctx, registry, agent } = harness()
  registry.registerFor(undefined, tool('write', { file_path: { type: 'string' } }))
  registry.registerFor(undefined, tool('pwsh', { command: { type: 'string' } }))

  apply(ctx, { exclude: ['write'] })

  assert.equal(advertises(registry, agent, 'write'), true)
  assert.equal(advertises(registry, agent, 'pwsh'), false)
})

test('does nothing when no sandbox policy service is composed', () => {
  const { ctx, registry, agent } = harness({ modeAbsent: true })
  registry.registerFor(undefined, tool('write', { file_path: { type: 'string' } }))

  apply(ctx, {})

  assert.equal(advertises(registry, agent, 'write'), true)
})

test('rewrites a refused escalation into one actionable instruction', async () => {
  const { ctx, registry, agent, handlers } = harness()
  registry.registerFor(undefined, tool('write', { file_path: { type: 'string' } }))
  apply(ctx, {})

  const post = handlers.get('tools/post-execute')
  assert.equal(post.length, 1)

  const exec = {
    name: 'write',
    agent,
    arguments: { file_path: 'a.txt', sandbox_permissions: 'workspace-write', justification: '' },
  }
  const result = {
    isError: true,
    content: [{ type: 'text', text: 'Error: invalid justification: expected a non-empty sentence' }],
  }

  // The clamp rewrites even though the tool is hidden: an argument the model
  // replayed from an older turn still fails the body's own validation.
  const decision = await post[0](exec, result, async () => ({ kind: 'accept' }))

  assert.equal(decision.kind, 'block')
  const text = decision.feedback[0].text
  assert.match(text, /invalid justification/)
  assert.match(text, /The write call did not run/)
  assert.match(text, /danger-full-access/)
})

test('leaves unrelated failures and successful calls alone', async () => {
  const { ctx, registry, agent, handlers } = harness()
  registry.registerFor(undefined, tool('write', { file_path: { type: 'string' } }))
  apply(ctx, {})
  const post = handlers.get('tools/post-execute')[0]

  const unrelated = {
    name: 'write',
    agent,
    arguments: { file_path: 'a.txt', sandbox_permissions: 'workspace-write', justification: 'x' },
  }
  const failure = { isError: true, content: [{ type: 'text', text: 'Error: ENOENT' }] }
  assert.equal((await post(unrelated, failure, async () => ({ kind: 'accept' }))).kind, 'accept')

  const success = { isError: false, content: [{ type: 'text', text: 'sandbox_permissions noted' }] }
  assert.equal((await post(unrelated, success, async () => ({ kind: 'accept' }))).kind, 'accept')

  const cleanArgs = { name: 'write', agent, arguments: { file_path: 'a.txt' } }
  assert.equal((await post(cleanArgs, failure, async () => ({ kind: 'accept' }))).kind, 'accept')
})

test('unloads every shadow when the plugin is disposed', async () => {
  const registry = new Registry()
  const handlers = new Map()
  const disposers = []
  const agents = []
  const ctx = {
    tools: registry,
    logger: { warn() {} },
    get(name) {
      if (name === 'agents') return { list: () => agents }
      if (name === 'approval') return { overrideOf: () => undefined, config: { policy: 'never' } }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'danger-full-access' }) }
      return undefined
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    effect(fn) { disposers.push(fn()) },
  }
  registry.onChange(() => { for (const handler of handlers.get('tools/change') ?? []) handler() })
  const agent = {
    name: 'lead',
    session: { id: 's' },
    ctx: { tools: { register: definition => registry.registerFor(agent, definition) }, effect: fn => fn() },
  }
  agents.push(agent)
  registry.registerFor(undefined, tool('write', { file_path: { type: 'string' } }))

  apply(ctx, {})
  assert.equal(advertises(registry, agent, 'write'), false)

  for (const dispose of disposers.splice(0)) dispose()

  assert.equal(advertises(registry, agent, 'write'), true)
})
