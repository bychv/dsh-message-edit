import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
// An explicit module URL lets the same tests exercise a sandbox's built core.
const { Session } = await import(process.env.DSH_TEST_SESSION_MODULE ?? '@deepseek-ai/dsh-session')
const JsonlSessionPersistence = process.env.DSH_TEST_JSONL_MODULE === undefined
  ? undefined
  : (await import(process.env.DSH_TEST_JSONL_MODULE)).default
const SandboxContext = process.env.DSH_TEST_CORDIS_MODULE === undefined
  ? undefined
  : (await import(process.env.DSH_TEST_CORDIS_MODULE)).Context
import { apply } from '../index.mjs'

function restoreSession(id, events, header, inheritedEventCount, projections) {
  // DSH format v3 requires the ownership state; v2 ignores the extra argument.
  return Session.fromRestore(id, events, header, inheritedEventCount, 'detached', projections)
}

test('host bundle loads even when a profile-local session peer lacks SessionLogOffset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-message-edit-compat-'))
  try {
    const peer = join(root, 'node_modules', '@deepseek-ai', 'dsh-session')
    await mkdir(peer, { recursive: true })
    await writeFile(join(peer, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-session', type: 'module', exports: './index.mjs',
    }))
    await writeFile(join(peer, 'index.mjs'), 'export const legacyPeer = true;\n')
    const bundle = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
    await writeFile(join(root, 'index.mjs'), bundle)
    const plugin = await import(pathToFileURL(join(root, 'index.mjs')).href)
    assert.equal(typeof plugin.apply, 'function')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function appendTurn(session, turn, durableInbox = false) {
  const user = {
    id: `user-${turn}`, role: 'user', content: [{ type: 'text', text: `question ${turn}` }],
    source: { kind: 'user' },
  }
  if (durableInbox) {
    session.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, inserted: [user],
    })
  }
  session.append('turn/start', { turn })
  if (durableInbox) {
    session.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, removedCount: 1, inserted: [],
    })
  }
  session.append('user/message', user, { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  const assistant = session.append('assistant/message', {
    turn, step: 1,
    ...session.header.version >= 2 ? { stream: [] } : {},
    message: {
      id: `assistant-${turn}`, role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    },
  }, { surfaceOp: 'append', ...session.header.version >= 2 ? {} : { sourceEventSeqs: [] } })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return assistant
}

// Exercise the public HTTP route and the selected real Session validator/fold.
// Agent execution and persistence I/O are deterministic adapters: no model calls
// or user profile/history writes are needed for these regression tests.
function harness({
  durableInbox = false,
  messageProjection,
  requestConfig,
  composerSelection,
  sourceAgentOptions = { provider: 'fixture', model: 'fixture' },
} = {}) {
  const projections = messageProjection === undefined ? undefined : [messageProjection]
  const source = Session.create('session-fixture-root', undefined, undefined, undefined, projections)
  if (requestConfig !== undefined) {
    source.append('request/header', { header: { config: requestConfig }, reason: 'initial' })
  }
  const first = appendTurn(source, 1, durableInbox)
  if (messageProjection !== undefined) {
    source.append('image/offload', { targets: [] })
  }
  const second = appendTurn(source, 2, durableInbox)
  if (composerSelection !== undefined) source.append('model/selection', composerSelection)
  const live = new Map([[source.id, source]])
  const liveOptions = new Map([[source.id, sourceAgentOptions]])
  const disk = new Map()
  const creates = []
  const resumes = []
  const queued = []
  let readHandles = 0
  let writeHandles = 0
  const persist = (session) => disk.set(session.id, JSON.stringify({
    header: session.header,
    events: session.snapshotEvents(),
    inheritedEventCount: session.inheritedEventCount,
  }))
  persist(source)
  const read = (id) => {
    if (!disk.has(id)) throw new Error(`Unknown fixture session ${id}`)
    return JSON.parse(disk.get(id))
  }
  const record = (id) => ({ header: read(id).header })
  const children = (id) => [...disk.keys()]
    .filter(childId => read(childId).header.parentSession === id)
    .map(childId => ({ session: record(childId), descendants: children(childId) }))
  const agent = (session) => ({
    session,
    options: liveOptions.get(session.id) ?? sourceAgentOptions,
    runMaintenance: callback => callback(),
    followup: message => queued.push(message),
  })
  let route
  const ctx = {
    effect: callback => callback(),
    webServer: { register: value => { route = value.handler; return () => {} } },
    sessions: {
      ...(projections === undefined ? {} : { messageProjections: projections }),
      get: id => live.get(id),
      flush: async session => { persist(session); return true },
    },
    agents: {
      get: id => live.has(id) ? agent(live.get(id)) : undefined,
      create: async (options) => {
        creates.push(options)
        const session = Session.create(options.sessionId, options.seed, {
          version: source.header.version, id: options.sessionId, createdAt: Date.now(),
          isSeeded: false, ...options.meta,
        }, options.inheritedEventCount, projections)
        live.set(session.id, session)
        liveOptions.set(session.id, options.agentOptions ?? sourceAgentOptions)
        return { agent: agent(session), dispose: async () => live.delete(session.id) }
      },
      resume: async (options) => {
        resumes.push(options)
        const { resumeSessionId } = options
        const stored = read(resumeSessionId)
        const session = restoreSession(
          resumeSessionId,
          stored.events,
          stored.header,
          stored.inheritedEventCount,
          projections,
        )
        live.set(session.id, session)
        liveOptions.set(session.id, options.agentOptions ?? sourceAgentOptions)
        return { agent: agent(session), dispose: async () => live.delete(session.id) }
      },
    },
    workspaceRegistry: { list: () => [] },
    sessionQuery: {
      readSession: async id => read(id),
      traceSession: async id => {
        const ancestors = []
        let rootId = id
        while (read(rootId).header.parentSession !== undefined) {
          rootId = read(rootId).header.parentSession
          ancestors.push(record(rootId))
        }
        return {
          complete: true, root: record(rootId), target: record(id),
          ancestors, descendants: children(id),
        }
      },
    },
    get: key => key !== 'sessionPersistence' ? undefined : source.header.version < 2
      ? { inspect: async id => read(id) }
      : {
        create: async (header, { inheritedEventCount }) => {
          writeHandles += 1
          let events = []
          let closed = false
          return {
            append: async value => { events = structuredClone(value) },
            flush: async () => {
              disk.set(header.id, JSON.stringify({ header, events, inheritedEventCount }))
              creates.push({ seed: events, meta: header, inheritedEventCount })
            },
            close: async () => { if (!closed) { closed = true; writeHandles -= 1 } },
          }
        },
        open: async id => {
          const stored = read(id)
          readHandles += 1
          let closed = false
          return {
            inheritedEventCount: stored.inheritedEventCount,
            read: async () => source.header.version >= 3
              ? { events: stored.events, eventState: 'detached' }
              : stored.events,
            close: async () => { if (!closed) { closed = true; readHandles -= 1 } },
          }
        },
      },
  }
  apply(ctx)
  return {
    source, first, second, creates, resumes, queued, live, read, persist,
    store: (id, value) => disk.set(id, JSON.stringify(value)),
    assertHandlesClosed: () => { assert.equal(readHandles, 0); assert.equal(writeHandles, 0) },
    async request(method, body) {
      const request = Readable.from(method === 'POST' ? [JSON.stringify(body)] : [])
      request.method = method
      request.url = `/message-edit?sessionId=${body.sessionId}`
      let status
      let response
      await route(request, {
        writeHead: value => { status = value },
        end: value => { response = JSON.parse(value) },
      })
      assert.equal(status, 200, JSON.stringify(response))
      return response
    },
  }
}

test('detached version creation forwards host message projections', {
  skip: Session.create.length < 5,
}, async () => {
  const projection = {
    type: 'image/offload',
    project: () => new Map(),
  }
  const h = harness({ messageProjection: projection })
  const result = await h.request('POST', {
    action: 'edit', sessionId: h.source.id, eventSeq: h.second.seq,
    blockIndex: 0, text: 'projected-history edit', cascade: 'truncate',
  })
  const stored = h.read(result.sessionId)
  assert.ok(stored.events.some(event => event.type === 'image/offload'))
  const restored = restoreSession(
    result.sessionId,
    stored.events,
    stored.header,
    stored.inheritedEventCount,
    [projection],
  )
  assert.equal(restored.deriveMessages().at(-1).content[0].text, 'projected-history edit')
  h.assertHandlesClosed()
})

for (const turn of [1, 2]) {
  test(`assistant edit in turn ${turn} survives cold restore with the exact inheritance cut`, async () => {
    const h = harness()
    const target = turn === 1 ? h.first : h.second
    const result = await h.request('POST', {
      action: 'edit', sessionId: h.source.id, eventSeq: target.seq,
      blockIndex: 0, text: 'edited answer', cascade: 'truncate',
    })
    assert.equal(result.queuedTurns, 0)
    const options = h.creates[0]
    const prefixLength = turn === 1 ? 0 : h.second.seq - 3
    assert.equal(options.inheritedEventCount ?? 0, prefixLength)
    assert.equal(options.meta.isSeeded ?? false, prefixLength > 0)
    const version = options.seed[prefixLength + (h.source.header.version >= 2 ? 1 : 0)]
    assert.equal(version.type, 'message-edit/version')
    assert.equal(version.ignorable, true)
    const edited = options.seed.findLast(event => event.type === 'assistant/message')
    if (h.source.header.version >= 2) {
      assert.deepEqual(edited.data.stream, [])
      assert.equal(Object.hasOwn(edited, 'sourceEventSeqs'), false)
    } else {
      assert.deepEqual(edited.sourceEventSeqs, [])
    }
    assert.ok(options.seed.filter(event => event.type !== 'message-edit/version')
      .every(event => !Object.hasOwn(event, 'ignorable')))
    assert.equal(h.source.deriveMessages().at(-1).content[0].text, 'answer 2')

    const stored = h.read(result.sessionId)
    const restored = restoreSession(result.sessionId, stored.events, stored.header, stored.inheritedEventCount)
    assert.equal(restored.deriveMessages().at(-1).content[0].text, 'edited answer')
    assert.equal(restored.inheritedEventCount, prefixLength)
    assert.equal(restored.ownEvents().filter(event => event.type === 'message-edit/version').length, 1)
    h.live.clear()
    const timeline = await h.request('GET', { sessionId: result.sessionId })
    assert.equal(timeline.messages.at(-1).text, 'edited answer')
    assert.deepEqual(timeline.undoStack, [h.source.id])
    assert.equal(timeline.versions.length, 2)
    h.assertHandlesClosed()
  })
}

test('a second-generation branch distinguishes inherited and owned version events on cold read', async () => {
  const h = harness()
  const first = await h.request('POST', {
    action: 'edit', sessionId: h.source.id, eventSeq: h.first.seq,
    blockIndex: 0, text: 'first edit', cascade: 'truncate',
  })
  const child = h.live.get(first.sessionId)
  const target = appendTurn(child, 2)
  // Flush the completed follow-up turn through the test persistence adapter.
  h.persist(child)
  const second = await h.request('POST', {
    action: 'edit', sessionId: child.id, eventSeq: target.seq,
    blockIndex: 0, text: 'second edit', cascade: 'truncate',
  })
  const options = h.creates[1]
  assert.equal(options.seed.filter(event => event.type === 'message-edit/version').length, 2)
  assert.equal(options.seed[options.inheritedEventCount + (h.source.header.version >= 2 ? 1 : 0)].type, 'message-edit/version')
  h.live.clear()
  const timeline = await h.request('GET', { sessionId: second.sessionId })
  assert.deepEqual(timeline.undoStack, [first.sessionId, h.source.id])
  assert.equal(timeline.messages.at(-1).text, 'second edit')
  h.assertHandlesClosed()
})

test('retry preserves queued inputs while metadata stays ignorable', async () => {
  const h = harness()
  const result = await h.request('POST', {
    action: 'retry', sessionId: h.source.id, turn: 1, cascade: 'preserve',
  })
  assert.equal(result.queuedTurns, 2)
  assert.deepEqual(h.queued.map(message => message.content[0].text), ['question 1', 'question 2'])
  assert.equal(h.creates[0].seed.find(event => event.type === 'message-edit/version').ignorable, true)
  assert.equal(h.creates[0].inheritedEventCount ?? 0, 0)
  h.assertHandlesClosed()
})

test('retry clears the inherited durable prompt before queueing its replacement', async () => {
  const h = harness({ durableInbox: true })
  const result = await h.request('POST', {
    action: 'retry', sessionId: h.source.id, turn: 1, cascade: 'truncate',
  })
  assert.equal(result.queuedTurns, 1)
  assert.deepEqual(h.queued.map(message => message.content[0].text), ['question 1'])

  const seed = h.creates[0].seed
  const branchEvents = seed.slice(h.creates[0].inheritedEventCount)
  const reset = branchEvents.find(event => event.type === 'agent/inbox/spliced')
  assert.deepEqual(reset?.data, {
    target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
  })
  assert.ok(branchEvents.findIndex(event => event.type === 'agent/inbox/spliced')
    < branchEvents.findIndex(event => event.type === 'message-edit/version'))
  h.assertHandlesClosed()
})

for (const fixture of [
  {
    name: 'edit',
    selection: { provider: 'composer', model: 'composer-edit', reasoningEffort: 'high' },
    operation: h => ({
      action: 'edit', sessionId: h.source.id, eventSeq: h.second.seq,
      blockIndex: 0, text: 'composer-routed edit', cascade: 'truncate',
    }),
  },
  {
    name: 'retry',
    selection: { provider: 'composer', model: 'composer-retry' },
    operation: h => ({
      action: 'retry', sessionId: h.source.id, turn: 2, cascade: 'truncate',
    }),
  },
]) {
  test(`${fixture.name} carries the lower composer model selection into the new branch`, async () => {
    const h = harness({
      requestConfig: {
        provider: 'history', model: 'history-model', reasoningEffort: 'low', maxTokens: 2048,
      },
      composerSelection: fixture.selection,
      sourceAgentOptions: {
        provider: 'startup', model: 'startup-model', reasoningEffort: 'medium', maxTokens: 1024,
      },
    })
    const result = await h.request('POST', fixture.operation(h))
    const stored = h.read(result.sessionId)
    assert.deepEqual(
      stored.events.findLast(event => event.type === 'model/selection')?.data,
      fixture.selection,
    )

    const resumed = h.resumes.findLast(options => options.resumeSessionId === result.sessionId)
    assert.equal(resumed.agentOptions.provider, fixture.selection.provider)
    assert.equal(resumed.agentOptions.model, fixture.selection.model)
    assert.equal(resumed.agentOptions.maxTokens, 2048)
    assert.equal(resumed.agentOptions.reasoningEffort, fixture.selection.reasoningEffort)
    h.assertHandlesClosed()
  })
}

test('an edited branch can be resumed and edited again after all live agents are removed', async () => {
  const h = harness()
  const first = await h.request('POST', {
    action: 'edit', sessionId: h.source.id, eventSeq: h.second.seq,
    blockIndex: 0, text: 'before restart', cascade: 'truncate',
  })
  h.live.clear()
  const history = await h.request('GET', { sessionId: first.sessionId })
  const target = history.messages.at(-1)
  const second = await h.request('POST', {
    action: 'edit', sessionId: first.sessionId, eventSeq: target.eventSeq,
    blockIndex: target.blockIndex, text: 'after restart', cascade: 'truncate',
  })
  h.live.clear()
  const restored = await h.request('GET', { sessionId: second.sessionId })
  assert.equal(restored.messages.at(-1).text, 'after restart')
  assert.deepEqual(restored.undoStack, [first.sessionId, h.source.id])
  h.assertHandlesClosed()
})

test('V3-to-V4 namespaced version metadata remains navigable and branchable', async () => {
  const h = harness()
  const first = await h.request('POST', {
    action: 'edit', sessionId: h.source.id, eventSeq: h.second.seq,
    blockIndex: 0, text: 'migrated branch', cascade: 'truncate',
  })
  const migrated = h.read(first.sessionId)
  const version = migrated.events.find(event => event.type === 'message-edit/version')
  assert.ok(version)
  version.type = 'plugin:message-edit/version'
  h.store(first.sessionId, migrated)
  h.live.clear()

  const history = await h.request('GET', { sessionId: first.sessionId })
  assert.deepEqual(history.undoStack, [h.source.id])
  assert.equal(history.versions.find(row => row.sessionId === first.sessionId)?.operation, 'edit')

  const target = history.messages.at(-1)
  const second = await h.request('POST', {
    action: 'edit', sessionId: first.sessionId, eventSeq: target.eventSeq,
    blockIndex: target.blockIndex, text: 'post-migration branch', cascade: 'truncate',
  })
  h.live.clear()
  const restored = await h.request('GET', { sessionId: second.sessionId })
  assert.equal(restored.messages.at(-1).text, 'post-migration branch')
  assert.deepEqual(restored.undoStack, [first.sessionId, h.source.id])
  h.assertHandlesClosed()
})

test('alpha JSONL validates new V4 branches and migrates V3 provenance losslessly', {
  skip: JsonlSessionPersistence === undefined || SandboxContext === undefined,
}, async () => {
  const h = harness()
  const result = await h.request('POST', {
    action: 'edit', sessionId: h.source.id, eventSeq: h.second.seq,
    blockIndex: 0, text: 'persistence migration', cascade: 'truncate',
  })
  const stored = h.read(result.sessionId)
  const currentRoot = await mkdtemp(join(tmpdir(), 'dsh-message-edit-v4-current-'))
  const migrationRoot = await mkdtemp(join(tmpdir(), 'dsh-message-edit-v4-migration-'))
  const contexts = []
  try {
    const current = new SandboxContext()
    contexts.push(current)
    await current.plugin(JsonlSessionPersistence, { root: currentRoot, compression: 'none' })
    const writer = await current.sessionPersistence.create(stored.header, {
      inheritedEventCount: stored.inheritedEventCount,
    })
    try {
      await writer.append(stored.events)
      await writer.flush()
    } finally {
      await writer.close()
    }
    const currentReader = await current.sessionPersistence.open(result.sessionId, 'read')
    try {
      const read = await currentReader.read()
      assert.equal(currentReader.header.version, 4)
      assert.equal(read.events.find(event => event.type === 'message-edit/version')?.ignorable, true)
    } finally {
      await currentReader.close()
    }

    const v3Path = join(migrationRoot, '_no-cwd', result.sessionId, 'session.v3.jsonl')
    await mkdir(join(migrationRoot, '_no-cwd', result.sessionId), { recursive: true })
    const physicalHeader = {
      type: 'session',
      ...stored.header,
      version: 3,
      delegationDepth: stored.header.delegationDepth ?? 0,
    }
    await writeFile(v3Path, [physicalHeader, ...stored.events]
      .map(row => JSON.stringify(row))
      .join('\n') + '\n')

    const migrated = new SandboxContext()
    contexts.push(migrated)
    await migrated.plugin(JsonlSessionPersistence, { root: migrationRoot, compression: 'none' })
    const prepared = await migrated.sessionPersistence.open(result.sessionId, 'read')
    let migratedEvents
    try {
      migratedEvents = (await prepared.read()).events
      assert.equal(prepared.header.version, 4)
      assert.equal(migratedEvents.find(event => event.type === 'plugin:message-edit/version')?.ignorable, true)
    } finally {
      await prepared.close()
    }
    await assert.rejects(readFile(join(migrationRoot, '_no-cwd', result.sessionId, 'session.v4.jsonl')))

    const publisher = await migrated.sessionPersistence.open(result.sessionId, 'write')
    await publisher.close()
    const published = await readFile(join(migrationRoot, '_no-cwd', result.sessionId, 'session.v4.jsonl'), 'utf8')
    assert.match(published, /"type":"plugin:message-edit\/version"/)

    const migratedStored = {
      header: { ...stored.header, version: 4 },
      events: migratedEvents,
      inheritedEventCount: stored.inheritedEventCount,
    }
    h.store(result.sessionId, migratedStored)
    h.live.clear()
    const history = await h.request('GET', { sessionId: result.sessionId })
    assert.deepEqual(history.undoStack, [h.source.id])
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await rm(currentRoot, { recursive: true, force: true })
    await rm(migrationRoot, { recursive: true, force: true })
  }
})
