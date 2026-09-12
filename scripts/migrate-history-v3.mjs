#!/usr/bin/env node

/**
 * Offline compatibility bridge for DSH 0.1.2 pre-release Session logs.
 *
 * It keeps every historical generation untouched and publishes a validated
 * session.v3 sibling that DSH 0.1.5+ will prefer after upgrade.
 */
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import {
  releasedV0SessionFormatCodec,
  releasedV1SessionFormatCodec,
  sessionFormatV0ToV1,
} from '@deepseek-ai/dsh-session-format-v0-to-v1'
import {
  assertReleasedV2Header,
  releasedV2SessionFormatCodec,
  restoreReleasedV2Artifact,
  sessionFormatV1ToV2,
} from '@deepseek-ai/dsh-session-format-v1-to-v2'
import {
  assertReleasedV3Header,
  releasedV3SessionFormatCodec,
  restoreReleasedV3Artifact,
  sessionFormatV2ToV3,
} from '@deepseek-ai/dsh-session-format-v2-to-v3'

const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)
const ZSTD_MAGIC = 0xFD2FB528
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const PROXY_PREFIX = 'dsh-message-edit-v3-migration:'
const CURRENT_VERSION = 3

const restoreV2 = artifact => restoreReleasedV2Artifact(artifact, new Set())
const restoreV3 = artifact => restoreReleasedV3Artifact(artifact, new Set())
const catalogV2 = createSessionFormatCatalog({
  currentVersion: 2,
  codecs: [
    releasedV0SessionFormatCodec,
    releasedV1SessionFormatCodec,
    releasedV2SessionFormatCodec,
  ],
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2],
  restoreCurrentHeader(header) {
    assertReleasedV2Header(header)
    return header
  },
  restoreCurrent: restoreV2,
  currentEncoder: releasedV2SessionFormatCodec,
  restoreTransformedCurrent: restoreV2,
})
const catalogV3 = createSessionFormatCatalog({
  currentVersion: CURRENT_VERSION,
  codecs: [
    releasedV0SessionFormatCodec,
    releasedV1SessionFormatCodec,
    releasedV2SessionFormatCodec,
    releasedV3SessionFormatCodec,
  ],
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3],
  restoreCurrentHeader(header) {
    assertReleasedV3Header(header)
    return header
  },
  restoreCurrent: restoreV3,
  currentEncoder: releasedV3SessionFormatCodec,
  restoreTransformedCurrent: restoreV3,
})

function jsonRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function clone(value) {
  return structuredClone(value)
}

/** Scan DSH's concatenated, independently checksummed Zstandard frames. */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error(`torn Zstandard frame at byte ${start}`)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) throw new Error(`torn Zstandard frame at byte ${start}`)
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) throw new Error(`torn Zstandard frame at byte ${start}`)
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`torn Zstandard frame at byte ${start}`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) throw new Error(`torn Zstandard frame at byte ${start}`)
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error(`torn Zstandard frame at byte ${start}`)
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

async function decodeContainer(path, compression) {
  const bytes = await readFile(path)
  let text
  if (compression === 'none') {
    text = bytes.toString('utf8')
  } else {
    const chunks = []
    for (const frame of scanZstdFrames(bytes)) {
      chunks.push(await zstdDecompressAsync(bytes.subarray(frame.start, frame.end)))
    }
    text = Buffer.concat(chunks).toString('utf8')
  }
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new Error('empty Session artifact')
  return lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid JSON at physical line ${index + 1}`, { cause: error })
    }
  })
}

async function encodeContainer(header, rows, compression) {
  const headerLine = Buffer.from(`${JSON.stringify(header)}\n`)
  const body = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + (rows.length === 0 ? '' : '\n'))
  if (compression === 'none') return Buffer.concat([headerLine, body])
  const frames = [await zstdCompressAsync(headerLine, CHECKSUM_OPTIONS)]
  if (body.length > 0) frames.push(await zstdCompressAsync(body, CHECKSUM_OPTIONS))
  return Buffer.concat(frames)
}

function generationOf(filename) {
  const match = /^session(?:\.v([0-9]+))?\.jsonl(\.zstd)?$/.exec(filename)
  if (match === null) return undefined
  return {
    version: match[1] === undefined ? 0 : Number(match[1]),
    compression: match[2] === undefined ? 'none' : 'zstd',
  }
}

async function sessionDirectories(root) {
  const result = []
  const visit = async path => {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    if (entries.some(entry => entry.isFile() && generationOf(entry.name) !== undefined)) {
      result.push({ path, entries })
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(resolve(path, entry.name))
    }
  }
  await visit(root)
  return result
}

function selectedHistoricalGeneration(directory) {
  const generations = directory.entries.flatMap(entry => {
    if (!entry.isFile()) return []
    const generation = generationOf(entry.name)
    return generation === undefined ? [] : [{ ...generation, filename: entry.name }]
  })
  if (generations.some(item => item.version >= CURRENT_VERSION)) return undefined
  const highest = Math.max(...generations.map(item => item.version))
  const selected = generations.filter(item => item.version === highest)
  if (selected.length !== 1) throw new Error(`ambiguous Session generation in ${directory.path}`)
  return selected[0]
}

function messageIdentity(event) {
  if (event.type === 'user/message') {
    return typeof event.data?.id === 'string' ? `user:${event.data.id}` : undefined
  }
  if (event.type === 'assistant/message') {
    return typeof event.data?.message?.id === 'string' ? `assistant:${event.data.message.id}` : undefined
  }
  return undefined
}

function sourceMessages(rows) {
  const result = new Map()
  for (const row of rows) {
    const identity = messageIdentity(row)
    if (identity !== undefined) result.set(count(row.seq, `${identity} seq`), identity)
  }
  return result
}

function expandedSources(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const result = []
  for (const entry of value) {
    if (!Array.isArray(entry)) {
      result.push(count(entry, `${label} member`))
      continue
    }
    if (entry.length !== 2) throw new Error(`${label} range must have two members`)
    const start = count(entry[0], `${label} range start`)
    const end = count(entry[1], `${label} range end`)
    if (start > end) throw new Error(`${label} range is reversed`)
    for (let seq = start; seq <= end; seq += 1) result.push(seq)
  }
  return result
}

function remapOne(value, mapping, label) {
  const source = count(value, label)
  const target = mapping.get(source)
  if (target === undefined) throw new Error(`${label} points to removed event ${source}`)
  return target
}

function remapRange(value, mapping, label) {
  const range = jsonRecord(value, label)
  return {
    ...range,
    start: remapOne(range.start, mapping, `${label} start`),
    end: remapOne(range.end, mapping, `${label} end`),
  }
}

function remapHistoricalReferences(event, mapping) {
  const target = clone(event)
  if (target.sourceEventSeqs !== undefined) {
    target.sourceEventSeqs = expandedSources(target.sourceEventSeqs, `${target.type} sourceEventSeqs`)
      .map(value => remapOne(value, mapping, `${target.type} sourceEventSeqs`))
  }
  if (target.surfaceOp !== undefined && target.surfaceOp !== 'append') {
    target.surfaceOp = remapRange(target.surfaceOp, mapping, `${target.type} surfaceOp`)
  }
  const data = jsonRecord(target.data, `${target.type} data`)
  if (target.type === 'command/done' && data.sourceEventSeq !== undefined) {
    data.sourceEventSeq = remapOne(data.sourceEventSeq, mapping, 'command/done sourceEventSeq')
  }
  if (target.type === 'compaction/summary' || target.type === 'compaction/prune') {
    data.shadowedRange = remapRange(data.shadowedRange, mapping, `${target.type} shadowedRange`)
    data.shadowedSeqs = data.shadowedSeqs.map(value => remapOne(value, mapping, `${target.type} shadowedSeqs`))
  }
  if (target.type === 'session/title' || target.type === 'session/title-llm-request') {
    data.messageSeqs = data.messageSeqs.map(value => remapOne(value, mapping, `${target.type} messageSeqs`))
  }
  return target
}

function reorderLegacySteps(entries, inheritedCut) {
  let changed = false
  let openTurn
  for (let index = 0; index + 1 < entries.length; index += 1) {
    const current = entries[index]
    const next = entries[index + 1]
    if (current.event.type === 'turn/start') openTurn = current.event.data?.turn
    if (current.event.type === 'turn/end') openTurn = undefined
    if (current.event.type !== 'user/message' || next.event.type !== 'step/start') continue
    if (openTurn === undefined || next.event.data?.turn !== openTurn) continue
    if (inheritedCut !== undefined
      && (current.originSeq < inheritedCut) !== (next.originSeq < inheritedCut)) {
      throw new Error('legacy user/message and step/start straddle the inherited cut')
    }
    entries[index] = next
    entries[index + 1] = current
    changed = true
    index += 1
  }
  return changed
}

function resequence(entries) {
  const mapping = new Map()
  entries.forEach((entry, index) => {
    if (entry.originSeq !== undefined) mapping.set(entry.originSeq, index)
  })
  return entries.map((entry, index) => ({
    ...remapHistoricalReferences(entry.event, mapping),
    seq: index,
  }))
}

function normalizeRetiredV0(headerValue, rows) {
  const header = jsonRecord(headerValue, 'format v0 header')
  const inheritedCut = count(header.seedLength ?? 0, 'format v0 seedLength')
  const entries = []
  for (const source of rows) {
    const event = clone(jsonRecord(source, 'format v0 event'))
    const originSeq = count(event.seq, `${event.type} seq`)
    if (event.type === 'session/end-seed') continue
    if (event.type === 'assistant/chunk') {
      throw new Error('retired 0.1.2 log mixes assistant/chunk with plugin-era v2 envelopes')
    }
    if (event.type === 'assistant/message') {
      const data = jsonRecord(event.data, 'assistant/message data')
      if (data.stream === undefined) {
        const sources = event.sourceEventSeqs
        if (sources !== undefined && expandedSources(sources, 'assistant/message sourceEventSeqs').length > 0) {
          throw new Error('assistant/message cites external chunks but has no embedded stream')
        }
        data.stream = []
      }
      delete event.sourceEventSeqs
    }
    entries.push({ event, originSeq })
  }
  if (inheritedCut > entries.length) throw new Error('format v0 seedLength exceeds the event log')
  reorderLegacySteps(entries, inheritedCut)
  if (inheritedCut > 0) {
    const time = entries[inheritedCut]?.event.time
      ?? entries[inheritedCut - 1]?.event.time
      ?? header.createdAt
    entries.splice(inheritedCut, 0, {
      event: { type: 'session/end-seed', seq: -1, time, data: { inherited: true } },
      originSeq: undefined,
    })
  }
  return {
    header: {
      type: 'session',
      version: 2,
      id: header.id,
      createdAt: header.createdAt,
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
      isSeeded: inheritedCut > 0,
      ...(header.origin === undefined ? {} : { origin: header.origin }),
      delegationDepth: header.delegationDepth ?? 0,
      ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    },
    rows: resequence(entries),
  }
}

function normalizeHistoricalInput(headerValue, rows) {
  const version = count(headerValue?.version, 'Session header version')
  const normalizedRows = rows.map(source => {
    const row = clone(jsonRecord(source, `format v${version} row`))
    if (version === 0 && row.type === 'permission/preset' && row.data?.origin !== undefined) {
      delete row.data.origin
    }
    if (version === 0 && row.type === 'turn/end'
      && row.data?.reason?.kind === 'aborted'
      && row.data.reason.reason?.stack !== undefined) {
      delete row.data.reason.reason.stack
    }
    return row
  })
  const retiredV2Shape = version === 0 && normalizedRows.some(row => (
    row?.type === 'assistant/message' && row.data?.stream !== undefined
  ))
  if (retiredV2Shape) return normalizeRetiredV0(headerValue, normalizedRows)

  const entries = normalizedRows.map(event => {
    return {
      event,
      originSeq: event.seq === undefined ? undefined : count(event.seq, `${event.type} seq`),
    }
  })
  // Released codecs may store auxiliary physical rows such as
  // reasoning-chunks beside ordinary events. Their seq is reconstructed by
  // the codec, so pre-migration event resequencing must not touch the stream.
  if (entries.some(entry => entry.originSeq === undefined)) {
    return { header: clone(headerValue), rows: entries.map(entry => entry.event) }
  }
  let inheritedCut
  if (version === 0 || version === 1) inheritedCut = count(headerValue.seedLength ?? 0, `format v${version} seedLength`)
  else {
    const marker = entries.find(entry => entry.event.type === 'session/end-seed' && entry.event.data?.inherited === true)
    inheritedCut = marker?.originSeq ?? 0
  }
  const changed = reorderLegacySteps(entries, inheritedCut)
  return { header: clone(headerValue), rows: changed ? resequence(entries) : entries.map(entry => entry.event) }
}

function proxyMessageEditEvents(sessionId, rows) {
  const proxies = new Map()
  const output = rows.map(source => {
    if (typeof source.type !== 'string' || !source.type.startsWith('message-edit/')) return source
    const marker = `${PROXY_PREFIX}${sessionId}:${source.seq}:${randomUUID()}`
    proxies.set(marker, clone(source))
    return {
      type: 'feedback/record',
      seq: source.seq,
      time: source.time,
      data: { text: marker },
      ...(source.ignorable === true ? { ignorable: true } : {}),
    }
  })
  return { rows: output, proxies }
}

function restoreWithCatalog(catalog, headerValue, rows) {
  const restore = catalog.createRestore(headerValue, { recovery: 'strict', validation: 'transformed' })
  for (const row of rows) restore.decodeRow(row)
  return restore.finish()
}

function migrateHistoricalArtifact(headerValue, rows) {
  const artifact = restoreWithCatalog(catalogV2, headerValue, rows)
  const entries = artifact.events.map(event => ({
    event: clone(event),
    originSeq: count(event.seq, `${event.type} seq`),
  }))
  const changed = reorderLegacySteps(entries, artifact.inheritedEventCount)
  const events = changed ? resequence(entries) : entries.map(entry => entry.event)
  const header = catalogV2.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount)
  const encodedRows = events.map(event => catalogV2.encodeCurrentEvent(event))
  return restoreWithCatalog(catalogV3, header, encodedRows)
}

function outputMessageSeqs(artifact) {
  const result = new Map()
  for (const event of artifact.events) {
    const identity = messageIdentity(event)
    if (identity !== undefined) result.set(identity, event.seq)
  }
  return result
}

function versionTarget(data) {
  if (data?.schemaVersion !== undefined) {
    return { parentId: data.inverse?.sessionId, targetSeq: data.effect?.targetEventSeq, modern: true }
  }
  return { parentId: data?.sourceSessionId, targetSeq: data?.targetEventSeq, modern: false }
}

function remapVersionTarget(data, plans, warnings, sessionId) {
  const target = versionTarget(data)
  if (typeof target.parentId !== 'string' || !Number.isSafeInteger(target.targetSeq)) return data
  const parent = plans.get(target.parentId)
  const mapped = parent?.oldMessageSeqToV3.get(target.targetSeq)
  if (mapped === undefined) {
    warnings.push(`${sessionId}: cannot remap target event ${target.parentId}#${target.targetSeq}; preserved old value`)
    return data
  }
  const result = clone(data)
  if (target.modern) result.effect.targetEventSeq = mapped
  else result.targetEventSeq = mapped
  return result
}

function finalizePlan(plan, plans, warnings) {
  const events = plan.artifact.events.map(event => {
    if (event.type !== 'feedback/record' || typeof event.data?.text !== 'string') return event
    const original = plan.proxies.get(event.data.text)
    if (original === undefined) return event
    return {
      type: original.type,
      seq: event.seq,
      time: original.time,
      data: remapVersionTarget(original.data, plans, warnings, plan.id),
      ignorable: true,
    }
  })
  const header = catalogV3.encodeCurrentHeader(plan.artifact.header, plan.artifact.inheritedEventCount)
  const rows = events.map(event => catalogV3.encodeCurrentEvent(event))
  // Re-read the exact physical output before any filesystem mutation.
  restoreWithCatalog(catalogV3, header, rows)
  return { header, rows }
}

async function preparePlan(sourcePath, generation) {
  try {
    const values = await decodeContainer(sourcePath, generation.compression)
    const rawHeader = values[0]
    const rawRows = values.slice(1)
    if (rawHeader?.version !== generation.version) {
      throw new Error(`filename generation v${generation.version} disagrees with header v${rawHeader?.version}`)
    }
    const messages = sourceMessages(rawRows)
    const normalized = normalizeHistoricalInput(rawHeader, rawRows)
    const id = normalized.header.id
    if (typeof id !== 'string' || id.length === 0) throw new Error('Session header lacks id')
    const proxied = proxyMessageEditEvents(id, normalized.rows)
    const artifact = migrateHistoricalArtifact(normalized.header, proxied.rows)
    const targetMessages = outputMessageSeqs(artifact)
    const oldMessageSeqToV3 = new Map()
    for (const [oldSeq, identity] of messages) {
      const target = targetMessages.get(identity)
      if (target !== undefined) oldMessageSeqToV3.set(oldSeq, target)
    }
    return {
      id,
      sourcePath,
      outputPath: resolve(dirname(sourcePath), `session.v3.jsonl${generation.compression === 'zstd' ? '.zstd' : ''}`),
      compression: generation.compression,
      sourceVersion: generation.version,
      proxies: proxied.proxies,
      artifact,
      oldMessageSeqToV3,
    }
  } catch (error) {
    throw new Error(`cannot migrate ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

async function atomicWrite(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    // Hard-link publication is atomic and refuses to replace an existing file.
    await link(temporary, path)
    await rm(temporary)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function isInside(parent, child) {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function parseArguments(argv) {
  const options = { apply: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--apply') {
      options.apply = true
      continue
    }
    if (argument === '--dsh-home' || argument === '--backup-dir') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a path`)
      options[argument === '--dsh-home' ? 'dshHome' : 'backupDir'] = resolve(value)
      index += 1
      continue
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    throw new Error(`unknown argument ${argument}`)
  }
  return options
}

function usage() {
  return [
    'Usage:',
    '  npm run migrate:history -- --dsh-home <path>',
    '  npm run migrate:history -- --dsh-home <path> --apply [--backup-dir <path>]',
    '',
    'The default is a read-only dry run. Stop DSH 0.1.2 before using --apply.',
  ].join('\n')
}

export async function migrateHistory(options) {
  if (options.dshHome === undefined) throw new Error('--dsh-home is required')
  const sessionsRoot = resolve(options.dshHome, 'sessions')
  const directories = await sessionDirectories(sessionsRoot)
  const selected = directories.flatMap(directory => {
    const generation = selectedHistoricalGeneration(directory)
    return generation === undefined ? [] : [{ directory, generation }]
  })

  // Phase one is entirely read-only and validates every artifact before writes.
  const prepared = []
  for (const item of selected) {
    const sourcePath = resolve(item.directory.path, item.generation.filename)
    prepared.push(await preparePlan(sourcePath, item.generation))
  }
  const plans = new Map(prepared.map(plan => [plan.id, plan]))
  if (plans.size !== prepared.length) throw new Error('duplicate Session ids found in historical storage')
  const warnings = []
  for (const plan of prepared) plan.final = finalizePlan(plan, plans, warnings)

  let backupDir
  if (options.apply && prepared.length > 0) {
    backupDir = options.backupDir ?? resolve(
      options.dshHome,
      'backups',
      `dsh-message-edit-v3-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    )
    const backupSessions = resolve(backupDir, 'sessions')
    if (isInside(sessionsRoot, backupDir)) {
      throw new Error('backup directory must be outside the sessions directory')
    }
    for (const plan of prepared) {
      const destination = resolve(backupSessions, relative(sessionsRoot, plan.sourcePath))
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(plan.sourcePath, destination, fsConstants.COPYFILE_EXCL)
    }
    for (const plan of prepared) {
      const bytes = await encodeContainer(plan.final.header, plan.final.rows, plan.compression)
      await atomicWrite(plan.outputPath, bytes)
    }
    await mkdir(backupDir, { recursive: true })
    await writeFile(resolve(backupDir, 'manifest.json'), `${JSON.stringify({
      createdAt: new Date().toISOString(),
      dshHome: options.dshHome,
      sessions: prepared.map(plan => ({
        id: plan.id,
        source: relative(sessionsRoot, plan.sourcePath),
        output: relative(sessionsRoot, plan.outputPath),
        sourceVersion: plan.sourceVersion,
        messageEditEvents: plan.proxies.size,
      })),
      warnings,
    }, null, 2)}\n`, { flag: 'wx' })
  }

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    dshHome: options.dshHome,
    selectedSessions: prepared.length,
    messageEditSessions: prepared.filter(plan => plan.proxies.size > 0).length,
    messageEditEvents: prepared.reduce((sum, plan) => sum + plan.proxies.size, 0),
    ...(backupDir === undefined ? {} : { backupDir }),
    warnings,
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  const report = await migrateHistory(options)
  console.log(JSON.stringify(report, null, 2))
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}
