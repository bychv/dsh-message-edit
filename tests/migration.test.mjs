import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { migrateHistory, scanZstdFrames } from '../scripts/migrate-history-v3.mjs'

const compress = promisify(zstdCompress)
const decompress = promisify(zstdDecompress)
const checksum = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

async function writeLegacyArtifact(path, header, events) {
  const first = await compress(Buffer.from(`${JSON.stringify(header)}\n`), checksum)
  const rest = await compress(Buffer.from(`${events.map(event => JSON.stringify(event)).join('\n')}\n`), checksum)
  await writeFile(path, Buffer.concat([first, rest]))
}

async function readCompressedArtifact(path) {
  const bytes = await readFile(path)
  const chunks = []
  for (const frame of scanZstdFrames(bytes)) {
    chunks.push(await decompress(bytes.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(chunks).toString('utf8').trimEnd().split(/\r?\n/).map(line => JSON.parse(line))
}

test('0.1.2 pre-migration keeps the old log and publishes a validated v3 sibling', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-message-edit-migration-'))
  try {
    const sessionId = 'session-migration-fixture'
    const directory = join(home, 'sessions', '--fixture--', sessionId)
    const source = join(directory, 'session.jsonl.zstd')
    const backup = join(home, 'backups', 'fixture')
    await mkdir(directory, { recursive: true })
    const time = 1_750_000_000_000
    const events = [
      { type: 'turn/start', seq: 0, time, data: { turn: 1 } },
      {
        type: 'user/message', seq: 1, time: time + 1, surfaceOp: 'append', data: {
          id: 'user-1', role: 'user', content: [{ type: 'text', text: 'question' }],
          source: { kind: 'user' },
        },
      },
      { type: 'step/start', seq: 2, time: time + 2, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message', seq: 3, time: time + 3, surfaceOp: 'append', data: {
          turn: 1, step: 1, stream: [], message: {
            id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'answer' }],
            source: { kind: 'model', provider: 'fixture', model: 'fixture' },
          },
        },
      },
      { type: 'step/end', seq: 4, time: time + 4, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 5, time: time + 5, data: { turn: 1, reason: { kind: 'completed' } } },
      {
        type: 'message-edit/version', seq: 6, time: time + 6, data: {
          schemaVersion: 2,
          effect: {
            id: 'effect-1', operation: 'edit', cascade: 'truncate', targetTurn: 1,
            targetEventSeq: 3, targetBlockIndex: 0, blockKind: 'assistant.response',
            before: 'before', after: 'answer',
          },
          inverse: { kind: 'restore-version', sessionId },
        },
      },
      { type: 'session/end-seed', seq: 7, time: time + 7, data: {} },
    ]
    await writeLegacyArtifact(source, {
      type: 'session', version: 0, id: sessionId, createdAt: time,
      cwd: 'F:\\fixture', seedLength: 0, delegationDepth: 0,
    }, events)
    const original = await readFile(source)

    const dryRun = await migrateHistory({ dshHome: home, apply: false })
    assert.deepEqual({
      selectedSessions: dryRun.selectedSessions,
      messageEditSessions: dryRun.messageEditSessions,
      messageEditEvents: dryRun.messageEditEvents,
      warnings: dryRun.warnings,
    }, { selectedSessions: 1, messageEditSessions: 1, messageEditEvents: 1, warnings: [] })
    await assert.rejects(readFile(join(directory, 'session.v3.jsonl.zstd')), { code: 'ENOENT' })

    const applied = await migrateHistory({ dshHome: home, apply: true, backupDir: backup })
    assert.equal(applied.selectedSessions, 1)
    assert.deepEqual(await readFile(source), original)
    assert.deepEqual(await readFile(join(backup, 'sessions', '--fixture--', sessionId, 'session.jsonl.zstd')), original)

    const migrated = await readCompressedArtifact(join(directory, 'session.v3.jsonl.zstd'))
    assert.equal(migrated[0].version, 3)
    const version = migrated.find(event => event.type === 'message-edit/version')
    assert.equal(version.ignorable, true)
    assert.equal(version.data.effect.targetEventSeq, 4)
    assert.ok(migrated.findIndex(event => event.type === 'step/start')
      < migrated.findIndex(event => event.type === 'user/message'))

    const repeated = await migrateHistory({ dshHome: home, apply: false })
    assert.equal(repeated.selectedSessions, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('released v0 packed chunks and transitional metadata migrate through normalized v2 order', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-message-edit-packed-migration-'))
  try {
    const sessionId = 'session-packed-fixture'
    const directory = join(home, 'sessions', '--fixture--', sessionId)
    const source = join(directory, 'session.jsonl.zstd')
    await mkdir(directory, { recursive: true })
    const time = 1_750_100_000_000
    await writeLegacyArtifact(source, {
      type: 'session', version: 0, id: sessionId, createdAt: time,
      cwd: 'F:\\fixture', seedLength: 0, delegationDepth: 0,
    }, [
      { type: 'permission/preset', seq: 0, time, data: { preset: 'default', origin: 'profile' } },
      { type: 'turn/start', seq: 1, time: time + 1, data: { turn: 1 } },
      {
        type: 'user/message', seq: 2, time: time + 2, surfaceOp: 'append', data: {
          id: 'packed-user', role: 'user', content: [{ type: 'text', text: 'question' }],
          source: { kind: 'user' },
        },
      },
      { type: 'step/start', seq: 3, time: time + 3, data: { turn: 1, step: 1 } },
      {
        type: 'reasoning-chunks', seq0: 4, time0: time + 4,
        data: { turn: 1, step: 1, index: 0, dt: [1, 1], texts: ['a', 'b', 'c'] },
      },
      {
        type: 'assistant/message', seq: 7, time: time + 7, surfaceOp: 'append',
        sourceEventSeqs: [[4, 6]], data: {
          turn: 1, step: 1, message: {
            id: 'packed-assistant', role: 'assistant', content: [{ type: 'reasoning', text: 'abc' }],
            source: { kind: 'model', provider: 'fixture', model: 'fixture' },
          },
        },
      },
      { type: 'step/end', seq: 8, time: time + 8, data: { turn: 1, step: 1 } },
      {
        type: 'turn/end', seq: 9, time: time + 9,
        data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user', stack: 'legacy debug stack' } } },
      },
    ])

    const report = await migrateHistory({ dshHome: home, apply: true })
    assert.equal(report.selectedSessions, 1)
    assert.deepEqual(report.warnings, [])
    const migrated = await readCompressedArtifact(join(directory, 'session.v3.jsonl.zstd'))
    assert.equal(migrated[0].version, 3)
    assert.ok(migrated.findIndex(event => event.type === 'step/start')
      < migrated.findIndex(event => event.type === 'user/message'))
    assert.equal(migrated.find(event => event.type === 'permission/preset').data.origin, undefined)
    assert.equal(migrated.find(event => event.type === 'turn/end').data.reason.reason.stack, undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
