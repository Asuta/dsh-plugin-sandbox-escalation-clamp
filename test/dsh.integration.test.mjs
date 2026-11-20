import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import * as clamp from '../index.js'

const integration = { skip: process.env.DSH_CLAMP_INTEGRATION !== '1' }
const pair = {
  sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'] },
  justification: { type: 'string' },
}
const sandboxDenial = '[sandbox: file access denied under read-only mode]'
const staleArguments = { text: 'example', sandbox_permissions: 'workspace-write', justification: '' }
const unknown = 'UNKNOWN_TOOL'

async function setup(t) {
  const require = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'))
  const { Context, symbols } = require('@deepseek-ai/cordis')
  const { ToolsService, defineTool } = require('@deepseek-ai/dsh-tools')
  const { createScope } = require('@deepseek-ai/dsh-scope')
  const { NativeToolExecutor } = require('@deepseek-ai/dsh-tool-executor-native')
  const { HarnessError } = require('@deepseek-ai/dsh-llm')
  const ctx = new Context()
  const state = { mode: 'danger-full-access' }
  let describe
  ctx.provide('systemPrompt', {
    tools(fn) { describe = fn },
    getSectionOrder: () => 10,
    section: () => () => {},
  })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: state.mode }) })
  ctx.provide('approval', { overrideOf: () => 'never' })
  const host = ctx.plugin(ToolsService)
  while (host.inertia) await host.inertia
  t.after(() => host.dispose())
  const tools = ctx.get('tools')
  const native = new NativeToolExecutor(ctx)
  tools.setExecutor(native)
  const agent = { session: {} }
  const scopedTools = createScope(ctx, agent).ctx.get('tools')
  const scope = agent
  const signal = new AbortController().signal
  const resolve = () => tools.resolve({ agent, signal })
  const describeScope = toolSet => describe({ scope, toolSet }).schemas
  const call = async (name, toolSet, args = staleArguments) => {
    const output = await native.execute({ agent, toolSet, signal, calls: [
      { id: 'fixture-id', type: 'tool_call', name, arguments: JSON.stringify(args) },
    ] })
    return output.results[0].result
  }
  const fixture = (name, execute) => defineTool({
    name,
    description: `Test ${name}`,
    parameters: { text: { type: 'string', required: true }, ...pair },
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    execute: async args => {
      if (args.sandbox_permissions !== undefined || args.justification !== undefined) {
        throw new HarnessError('invalid justification: expected a non-empty sentence', 'SANDBOX_ESCALATION_INVALID_ARGUMENT')
      }
      return execute(args)
    },
  })
  const mount = async () => {
    const plugin = ctx.plugin(clamp)
    while (plugin.inertia) await plugin.inertia
    return plugin
  }
  return { require, ctx, state, tools, raw: tools[symbols.original], scopedTools, resolve, describeScope, call, fixture, mount }
}

test('real DSH admits only the original registered tools and keeps admitted step identity', integration, async t => {
  const { tools, raw, scopedTools, resolve, describeScope, call, fixture, mount } = await setup(t)
  let allowed = false
  const restrictedTool = fixture('restricted', args => args.text)
  tools.register(fixture('conditional', args => args.text), { when: () => allowed })
  tools.register(restrictedTool)
  const before = { definitions: raw.definitions, executable: raw.executable }
  const plugin = await mount()

  const blocked = await resolve()
  assert.deepEqual(describeScope(blocked).map(schema => schema.name), ['restricted'])
  assert.equal((await call('conditional', blocked)).error.info.code, unknown)
  allowed = true
  const admitted = await resolve()
  assert.deepEqual(Object.keys(describeScope(admitted).find(schema => schema.name === 'conditional').parameters.properties), ['text'])
  assert.equal((await call('conditional', admitted)).value, 'example')
  assert.equal((await call('conditional')).error.info.code, unknown)

  const removeRestriction = scopedTools.restrict({ deny: ['restricted'] })
  assert.equal((await call('restricted', admitted)).error.info.code, unknown)
  assert(!describeScope(await resolve()).some(schema => schema.name === 'restricted'))
  removeRestriction()
  assert.equal((await call('restricted', await resolve())).value, 'example')

  const removeOriginal = tools.register(fixture('late', () => 'original'))
  const originalStep = await resolve()
  assert.equal((await call('late', originalStep)).value, 'original')
  removeOriginal()
  assert.equal((await call('late', originalStep)).error.info.code, unknown)
  tools.register(fixture('late', () => 'replacement'))
  assert.equal((await call('late', originalStep)).error.info.code, unknown)
  assert.equal((await call('late', await resolve())).value, 'replacement')

  const removeOverride = scopedTools.register(fixture('late', () => 'scope-local'))
  assert.equal((await call('late', await resolve())).value, 'scope-local')
  removeOverride()
  assert.equal((await call('late', await resolve())).value, 'replacement')

  await plugin.dispose()
  assert.equal(raw.definitions, before.definitions)
  assert.equal(raw.executable, before.executable)
  const restored = await resolve()
  assert(Object.hasOwn(describeScope(restored).find(schema => schema.name === 'late').parameters.properties, 'sandbox_permissions'))
  assert.equal((await call('late', restored)).error.info.code, 'SANDBOX_ESCALATION_INVALID_ARGUMENT')
})

test('shipped write and edit repair stale arguments while preserving sandbox and tool guards', integration, async t => {
  const { require, ctx, state, tools, resolve, describeScope, call, mount } = await setup(t)
  const { FsError } = require('@deepseek-ai/dsh-fs')
  const fileTools = require('@deepseek-ai/dsh-tool-fs')
  let text = null
  function assertWritable(policy) {
    if (policy.mode === 'read-only') throw new FsError('Read-only fixture', 'FS_SANDBOX_DENIED')
    assert.equal(policy.mode, state.mode)
  }
  ctx.provide('workingDirectory', { ensure: () => undefined })
  ctx.provide('fs', {
    sandboxMode: 'read-only',
    resolve: path => ({ displayPath: path }),
    processPath: target => target.displayPath,
    writeText(_target, content, _intent, _signal, policy) {
      assertWritable(policy)
      const before = text
      text = content
      return { operation: before === null ? 'create' : 'update', before, after: text, version: 'fixture' }
    },
    editText(_target, { oldString, newString }, _intent, _signal, policy) {
      assertWritable(policy)
      const before = text
      text = text.replace(oldString, newString)
      return { before, after: text, version: 'fixture' }
    },
  })
  const fsPlugin = ctx.plugin(fileTools, { read: false, readImage: false })
  while (fsPlugin.inertia) await fsPlugin.inertia

  const args = { file_path: 'fixture.txt', sandbox_permissions: 'workspace-write', justification: '' }
  const write = { ...args, content: 'original' }
  const edit = { ...args, old_string: 'original', new_string: 'edited' }
  assert.equal((await call('write', await resolve(), write)).error.info.code, 'SANDBOX_ESCALATION_INVALID_ARGUMENT')
  assert.equal(text, null)

  const removeGuard = tools.guard(exec => exec.arguments.sandbox_permissions
    ? { reason: 'The original input reaches the guard', info: { name: 'GuardDenial', code: 'GUARD_DENIED' } }
    : undefined)
  await mount()
  const step = await resolve()
  for (const tool of describeScope(step)) {
    assert(!Object.hasOwn(tool.parameters.properties, 'sandbox_permissions'))
  }
  assert.equal((await call('write', step, write)).error.info.code, 'GUARD_DENIED')
  removeGuard()
  assert.equal((await call('write', step, write)).value.after, 'original')
  assert.equal((await call('edit', step, edit)).value.after, 'edited')

  state.mode = 'read-only'
  const denied = await call('write', step, write)
  assert.equal(denied.error.info.code, 'FS_SANDBOX_DENIED')
  assert.equal(denied.error.message, sandboxDenial)
  assert.deepEqual(denied.content, [{ type: 'text', text: `Error: ${sandboxDenial}` }])
  assert.equal(text, 'edited')
})
