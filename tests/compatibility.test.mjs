import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { apply } from '../index.mjs'

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

function appendTurn(session, turn) {
  session.append('turn/start', { turn })
  session.append('user/message', {
    id: `user-${turn}`, role: 'user', content: [{ type: 'text', text: `question ${turn}` }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  const assistant = session.append('assistant/message', {
    turn, step: 1, message: {
      id: `assistant-${turn}`, role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return assistant
}

// Exercise the public HTTP route and the real alpha.5 Session validator/fold.
// Agent execution and persistence I/O are deterministic adapters: no model calls
// or user profile/history writes are needed for these regression tests.
function harness() {
  const source = Session.create('session-fixture-root')
  const first = appendTurn(source, 1)
  const second = appendTurn(source, 2)
  const live = new Map([[source.id, source]])
  const disk = new Map()
  const creates = []
  const queued = []
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
    options: { provider: 'fixture', model: 'fixture' },
    runMaintenance: callback => callback(),
    followup: message => queued.push(message),
  })
  let route
  const ctx = {
    effect: callback => callback(),
    webServer: { register: value => { route = value.handler; return () => {} } },
    sessions: {
      get: id => live.get(id),
      flush: async session => { persist(session); return true },
    },
    agents: {
      get: id => live.has(id) ? agent(live.get(id)) : undefined,
      create: async (options) => {
        creates.push(options)
        const session = Session.create(options.sessionId, options.seed, {
          version: 0, id: options.sessionId, createdAt: Date.now(),
          isSeeded: false, ...options.meta,
        }, options.inheritedEventCount)
        live.set(session.id, session)
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
    get: key => key === 'sessionPersistence' ? { inspect: async id => read(id) } : undefined,
  }
  apply(ctx)
  return {
    source, first, second, creates, queued, live, read, persist,
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
    const version = options.seed[prefixLength]
    assert.equal(version.type, 'message-edit/version')
    assert.equal(version.ignorable, true)
    assert.ok(options.seed.filter(event => event.type !== 'message-edit/version')
      .every(event => !Object.hasOwn(event, 'ignorable')))
    assert.equal(h.source.deriveMessages().at(-1).content[0].text, 'answer 2')

    const stored = h.read(result.sessionId)
    const restored = Session.fromRestore(result.sessionId, stored.events, stored.header, stored.inheritedEventCount)
    assert.equal(restored.deriveMessages().at(-1).content[0].text, 'edited answer')
    assert.equal(restored.inheritedEventCount, prefixLength)
    assert.equal(restored.ownEvents().filter(event => event.type === 'message-edit/version').length, 1)
    h.live.clear()
    const timeline = await h.request('GET', { sessionId: result.sessionId })
    assert.equal(timeline.messages.at(-1).text, 'edited answer')
    assert.deepEqual(timeline.undoStack, [h.source.id])
    assert.equal(timeline.versions.length, 2)
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
  assert.equal(options.seed[options.inheritedEventCount].type, 'message-edit/version')
  h.live.clear()
  const timeline = await h.request('GET', { sessionId: second.sessionId })
  assert.deepEqual(timeline.undoStack, [first.sessionId, h.source.id])
  assert.equal(timeline.messages.at(-1).text, 'second edit')
})

test('retry preserves queued inputs while metadata stays ignorable', async () => {
  const h = harness()
  const result = await h.request('POST', {
    action: 'retry', sessionId: h.source.id, turn: 1, cascade: 'preserve',
  })
  assert.equal(result.queuedTurns, 2)
  assert.deepEqual(h.queued.map(message => message.content[0].text), ['question 1', 'question 2'])
  assert.equal(h.creates[0].seed[0].ignorable, true)
  assert.equal(h.creates[0].inheritedEventCount, undefined)
})
