import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

const pair = {
  sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'] },
  justification: { type: 'string' },
}
const argumentSchema = {
  type: 'object',
  properties: { file_path: { type: 'string' }, content: { type: 'string' }, ...pair },
  required: ['file_path', 'content'],
}
const bareArgs = { file_path: 'clamp-test.txt', content: 'example' }
const staleArgs = Object.freeze({ ...bareArgs, sandbox_permissions: 'workspace-write', justification: '' })
const hint = '[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'
const denial = '[sandbox: file access denied under read-only mode]'

// Use prototype getters and private state to test original receiver semantics.
class FileTool {
  #label
  calls = []

  constructor(name = 'write') { this.#label = name }
  get name() { return this.#label }
  get description() { return `Use ${this.#label}` }
  get parameters() { return argumentSchema }
  get output() { return { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] } }
  get timeoutMs() { return 100 }
  isConcurrencySafe() { return this.#label === 'write' }
  presentCall() { return this.#label }
  presentResult() { return this.#label }
  projectContent() { return this.#label }
  finalizeContent() { return this.#label }
  execute(args, exec) {
    this.calls.push({ args, exec })
    return this.#label
  }
}

function harness({ mode = 'danger-full-access', policy = 'never' } = {}) {
  const registered = new Map()
  const handlers = new Map()
  const effects = []
  const state = { mode, policy }
  const agent = { session: {} }
  const registry = {
    definitions(scope, step) {
      return [...registered.keys()].map(name => this.executable(name, scope, step)).filter(Boolean)
    },
    executable(name, scope, step) {
      return scope === agent && (!step || step.has(name)) ? registered.get(name) : undefined
    },
  }
  const ctx = {
    tools: registry,
    get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: state.mode }) }
      if (name === 'approval') return { overrideOf: () => state.policy }
    },
    logger: { warn: message => assert.fail(message) },
    effect(run) { effects.push(run()) },
    on(event, handler) { handlers.set(event, handler) },
  }
  const run = (name, args, result) => handlers.get('tools/execute')({ agent, name, arguments: args }, async () => result)
  const parameters = name => registry.definitions(agent).find(tool => tool.name === name).parameters
  const invoke = (name, args) => registry.executable(name, agent).execute(args, { agent })
  return { ctx, registry, state, agent, registered, run, parameters, invoke, unload: () => effects.pop()() }
}

function failure(code, message) {
  return {
    isError: true,
    error: { message, info: { name: 'ExampleError', code } },
    content: [{ type: 'text', text: `Error: ${message}` }],
    additionalContexts: [],
  }
}

test('write and edit lose only the escalation pair in model declarations', () => {
  const { ctx, registered, parameters } = harness()
  for (const name of ['write', 'edit']) registered.set(name, new FileTool(name))
  apply(ctx)
  for (const name of registered.keys()) {
    assert.deepEqual(Object.keys(parameters(name).properties), ['file_path', 'content'])
    assert.deepEqual(parameters(name).required, argumentSchema.required)
  }
  assert.deepEqual(Object.keys(argumentSchema.properties), ['file_path', 'content', ...Object.keys(pair)])
})

test('repairs stale write and edit arguments once and preserves the invocation context', () => {
  const { ctx, agent, registered, invoke } = harness()
  for (const name of ['write', 'edit']) registered.set(name, new FileTool(name))
  apply(ctx)
  for (const [name, tool] of registered) {
    assert.equal(invoke(name, staleArgs), name)
    assert.deepEqual(tool.calls, [{ args: bareArgs, exec: { agent } }])
    assert(Object.isFrozen(tool.calls[0].args))
  }
  assert.equal(staleArgs.sandbox_permissions, 'workspace-write')
})

test('honors a live policy switch and passes a valid wider approval request through', () => {
  const { ctx, registered, state, parameters, invoke } = harness({ mode: 'read-only', policy: 'ask' })
  const write = new FileTool()
  registered.set('write', write)
  apply(ctx)
  const approvedArgs = { ...staleArgs, justification: 'Write within the workspace' }
  assert.equal(parameters('write'), argumentSchema)
  invoke('write', approvedArgs)
  assert.equal(write.calls[0].args, approvedArgs)
  state.policy = 'never'
  assert(!Object.hasOwn(parameters('write').properties, 'sandbox_permissions'))
  invoke('write', approvedArgs)
  assert.deepEqual(write.calls[1].args, bareArgs)
})

test('defers to the original tool when the sandbox policy cannot be resolved', () => {
  const { ctx, registered, parameters, invoke } = harness({ mode: undefined })
  const write = new FileTool()
  registered.set('write', write)
  ctx.get = () => undefined
  apply(ctx)
  assert.equal(parameters('write'), argumentSchema)
  invoke('write', staleArgs)
  assert.equal(write.calls[0].args, staleArgs)
})

test('preserves business fields and ignores the executor-owned run_code transport', async () => {
  const { ctx, agent, registry, registered, run } = harness()
  class BusinessTool extends FileTool {
    get parameters() {
      return { type: 'object', properties: { justification: { type: 'string' } }, required: ['justification'] }
    }
  }
  class CustomTool extends FileTool {
    get parameters() {
      return { type: 'object', properties: { ...pair, sandbox_permissions: { type: 'string', enum: ['admin'] } } }
    }
  }
  const result = failure('SANDBOX_ESCALATION_INVALID_ARGUMENT', 'Invalid justification')
  for (const tool of [new BusinessTool('business'), new CustomTool('custom'), new FileTool('run_code')]) {
    registered.set(tool.name, tool)
  }
  apply(ctx)
  for (const tool of registered.values()) {
    assert.equal(registry.definitions(agent).find(entry => entry.name === tool.name), tool)
    assert.equal(registry.executable(tool.name, agent), tool)
    assert.equal(await run(tool.name, staleArgs, result), result)
  }
})

test('applies exclude and a fixed tool list to schema, execution, and explanation', async () => {
  const { ctx, agent, registered, registry, run } = harness()
  for (const name of ['write', 'edit', 'apply_patch']) registered.set(name, new FileTool(name))
  apply(ctx, { discover: false, tools: ['write', 'edit'], exclude: ['edit'] })
  const result = failure('SANDBOX_ESCALATION_INVALID_ARGUMENT', 'Invalid justification')
  for (const name of ['edit', 'apply_patch']) {
    const original = registered.get(name)
    assert.equal(registry.definitions(agent).find(entry => entry.name === name), original)
    assert.equal(registry.executable(name, agent), original)
    assert.equal(await run(name, staleArgs, result), result)
  }
  const explained = await run('write', staleArgs, result)
  assert.match(explained.error.message, /Retry without sandbox_permissions and justification/)
  assert.match(explained.content.at(-1).text, /Retry without/)
  assert.equal(explained.error.info, result.error.info)
  assert.equal(explained.additionalContexts, result.additionalContexts)
})

test('forwards output, prototype methods and non-enumerable tool properties', () => {
  const { ctx, registered, registry, agent } = harness()
  const write = new FileTool()
  registered.set('write', write)
  apply(ctx)
  for (const tool of [registry.executable('write', agent), ...registry.definitions(agent)]) {
    assert.equal(tool.description, 'Use write')
    assert.equal(tool.timeoutMs, 100)
    assert.equal(tool.output.schema.type, 'string')
    assert.equal(tool.isConcurrencySafe(), true)
    for (const key of ['presentCall', 'presentResult', 'projectContent', 'finalizeContent']) {
      const callback = tool[key]
      assert.equal(callback(), 'write')
    }
  }
})

test('preserves denials and drops misleading escalation hints only when an ask is impossible', async () => {
  const { ctx, registered, state, run } = harness({ mode: 'read-only', policy: 'never' })
  registered.set('write', new FileTool())
  apply(ctx)
  const denied = failure('FS_SANDBOX_DENIED', `${denial}\n${hint}\nKeep this detail.`)
  const cleaned = await run('write', staleArgs, denied)
  assert.equal(cleaned.error.info, denied.error.info)
  assert.equal(cleaned.error.message, `${denial}\nKeep this detail.`)
  assert.deepEqual(cleaned.content, [{ type: 'text', text: `Error: ${denial}\nKeep this detail.` }])
  const cleanCallDenial = await run('write', bareArgs, denied)
  assert.deepEqual(cleanCallDenial, cleaned)
  state.policy = 'ask'
  assert.equal(await run('write', staleArgs, denied), denied)
})

test('leaves failures with unrelated codes and user approval outcomes intact', async () => {
  const { ctx, registered, run } = harness()
  registered.set('write', new FileTool())
  apply(ctx)
  for (const code of ['OTHER', 'SANDBOX_ESCALATION_REJECTED', 'SANDBOX_ESCALATION_CANCELLED']) {
    const result = failure(code, 'sandbox_permissions: invalid justification')
    assert.equal(await run('write', staleArgs, result), result)
  }
})

test('only wraps current lookup results and restores the original methods on unload', () => {
  const { ctx, registered, registry, agent, unload } = harness()
  const { definitions, executable } = registry
  apply(ctx)
  assert.equal(registry.executable('write', agent), undefined)
  const write = new FileTool()
  registered.set('write', write)
  assert.notEqual(registry.executable('write', agent), write)
  assert.equal(registry.executable('write', agent, new Set()), undefined)
  registered.delete('write')
  assert.equal(registry.executable('write', agent), undefined)
  unload()
  assert.equal(registry.definitions, definitions)
  assert.equal(registry.executable, executable)
})
