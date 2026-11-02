/**
 * dsh-session-usage — host half.
 *
 * Aggregates every recorded DSH conversation's token consumption straight from
 * the session store (`$DSH_HOME/sessions/<project>/<session>/session.v4.jsonl.zstd`),
 * so the report is complete for past conversations instead of starting from the
 * moment the plugin was installed.
 *
 * The session log is an append-only sequence of independent zstd frames, each
 * holding one or more JSONL events. Node's `zstdDecompressSync` stops at the
 * first frame, so the file is split on the zstd magic number and decompressed
 * frame by frame. Only the event kinds that carry accounting data are parsed:
 * the giant `tool/result` / `request/header` lines are skipped by a cheap
 * substring pre-filter before any JSON parse.
 *
 * @module dsh-session-usage
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import zlib from 'node:zlib'

/** Plugin name used by the loader row. */
export const name = 'dsh-session-usage'

/** Services this plugin needs mounted before its body runs. */
export const inject = ['webServer']

/** Route prefix of the host API. */
const API_PREFIX = '/api/dsh-session-usage'

/** Cache document shape version; a mismatch discards the stored cache. */
const CACHE_VERSION = 6

/** zstd frame magic number. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Session log file name inside one session directory. */
const SESSION_FILE = 'session.v4.jsonl.zstd'

/** Resolve the DSH home directory. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

import { deepseekSpendCny } from './pricing.js'

/** Directory holding every recorded conversation. */
function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** Where the parse cache lives. */
function cachePath() {
  return join(dshHome(), 'dsh-session-usage', 'cache.json')
}

/** Marker written on mount so an outside health check can see the host half is live. */
function markerPath() {
  return join(dshHome(), 'dsh-session-usage', 'applied.json')
}

/**
 * Best-effort mount marker: diagnostic only, never fatal. Recording the stage
 * makes a plugin that fails to mount distinguishable from one never loaded.
 * @param {string} stage where the host half currently is
 * @param {object} [extra] extra diagnostics
 */
function writeMarker(stage, extra) {
  try {
    mkdirSync(join(dshHome(), 'dsh-session-usage'), { recursive: true })
    writeFileSync(
      markerPath(),
      JSON.stringify({
        pid: process.pid,
        at: new Date().toISOString(),
        version: '0.1.0',
        stage: stage,
        execPath: process.execPath,
        node: process.versions && process.versions.node,
        ...(extra || {}),
      }) + String.fromCharCode(10),
    )
  } catch {
    // A read-only home must not break the app.
  }
}

/** The workspace store that maps a sidebar folder to the conversations under it. */
function workspacesPath() {
  return join(dshHome(), 'storages', 'workspace.json')
}

/**
 * Read the workspace index so the sidebar can roll a folder's sessions up.
 * A missing or malformed store is not an error: the sidebar then simply has no
 * folder totals to show.
 * @returns {Array<{ id: string, title: string, path: string | null, sessionIds: string[] }>}
 */
function readWorkspaces() {
  let doc
  try {
    doc = JSON.parse(readFileSync(workspacesPath(), 'utf8'))
  } catch {
    return []
  }
  const table = doc && doc.tables && doc.tables.workspaces
  if (!table || typeof table !== 'object') return []
  const out = []
  for (const [id, value] of Object.entries(table)) {
    if (!value || typeof value !== 'object') continue
    out.push({
      id,
      title: typeof value.title === 'string' ? value.title : '',
      path: typeof value.path === 'string' ? value.path : null,
      sessionIds: Array.isArray(value.sessionIds) ? value.sessionIds.filter(item => typeof item === 'string') : [],
    })
  }
  return out
}

/**
 * Split a concatenated zstd stream into frames and decompress each.
 * A trailing partial frame (a log being appended while we read) is ignored.
 * @param {Buffer} buf
 * @returns {string} the concatenated text of every complete frame
 */
function decodeFrames(buf) {
  const offsets = []
  let cursor = 0
  for (;;) {
    const found = buf.indexOf(ZSTD_MAGIC, cursor)
    if (found < 0) break
    offsets.push(found)
    cursor = found + ZSTD_MAGIC.length
  }
  if (offsets.length === 0) return ''
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      // Truncated or torn tail frame: nothing usable past this point.
    }
  }
  return parts.join('')
}

/** Empty accumulator for one conversation. */
function emptySummary() {
  return {
    title: null,
    firstUser: null,
    cwd: null,
    delegationDepth: 0,
    provider: null,
    model: null,
    requests: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    spendCny: 0,
    firstAt: null,
    lastAt: null,
    // Local-day buckets so the UI can show a rolling multi-day window without rescanning.
    days: {},
    // Epoch-minute buckets (last hours only) and epoch-hour buckets back the
    // sidebar windows up to 30 days, so 10 分钟 … 30 天 need no rescan either.
    minutes: {},
    hours: {},
  }
}

/** Epoch-minute bucket key. */
function minuteKeyOf(ms) {
  return String(Math.floor(ms / 60000))
}

/** Epoch-hour bucket key. */
function hourKeyOf(ms) {
  return String(Math.floor(ms / 3600000))
}

/** Add one event to a bucket, creating it on first use. */
function bumpBucket(buckets, key, tokens, spend) {
  const bucket = buckets[key] ?? (buckets[key] = { t: 0, r: 0, c: 0 })
  bucket.t += tokens
  bucket.r += 1
  bucket.c += spend
}

/** Local-timezone day key (YYYY-MM-DD) used for every bucket in this plugin. */
function dayKeyOf(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return date.getFullYear() + '-' + month + '-' + day
}

/** Pull the first text part out of a message content array. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') return part.text
  }
  return null
}

/**
 * Parse one session log into its conversation summary.
 * @param {string} file absolute path of the session log
 * @returns {object} the summary
 */
function parseSession(file) {
  const text = decodeFrames(readFileSync(file))
  const summary = emptySummary()
  if (text === '') return summary

  for (const line of text.split('\n')) {
    if (line === '') continue
    const isHeader = line.startsWith('{"type":"session"')
    if (!isHeader
      && !line.includes('"session/title"')
      && !line.includes('"assistant/message"')
      && !line.includes('"user/message"')
      && !line.includes('"turn/start"')) continue

    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const time = typeof event.time === 'number' ? event.time : null
    if (time !== null) {
      if (summary.firstAt === null || time < summary.firstAt) summary.firstAt = time
      if (summary.lastAt === null || time > summary.lastAt) summary.lastAt = time
    }

    switch (event.type) {
      case 'session': {
        if (typeof event.cwd === 'string') summary.cwd = event.cwd
        if (typeof event.createdAt === 'number' && summary.firstAt === null) summary.firstAt = event.createdAt
        if (typeof event.delegationDepth === 'number') summary.delegationDepth = event.delegationDepth
        break
      }
      case 'session/title': {
        const title = event.data && event.data.title
        if (typeof title === 'string' && title.trim() !== '') summary.title = title.trim()
        break
      }
      case 'turn/start': {
        summary.turns += 1
        break
      }
      case 'user/message': {
        if (summary.firstUser === null) {
          const value = textOf(event.data && event.data.content)
          if (value !== null) summary.firstUser = value
        }
        break
      }
      case 'assistant/message': {
        const data = event.data
        if (!data) break
        const source = data.message && data.message.source
        if (source && typeof source.provider === 'string') summary.provider = source.provider
        if (source && typeof source.model === 'string') summary.model = source.model
        const usage = data.usage
        if (usage && typeof usage === 'object') {
          summary.requests += 1
          const input = Number(usage.inputTokens) || 0
          const output = Number(usage.outputTokens) || 0
          const cacheRead = Number(usage.cacheReadTokens) || 0
          const cacheWrite = Number(usage.cacheWriteTokens) || 0
          summary.inputTokens += input
          summary.outputTokens += output
          summary.cacheReadTokens += cacheRead
          summary.cacheWriteTokens += cacheWrite
          const delta = Number(usage.totalTokens) || (input + output + cacheRead + cacheWrite)
          summary.totalTokens += delta
          const atMs = time ?? Date.now()
          const spend = deepseekSpendCny(summary.model, usage, atMs)
          summary.spendCny += spend
          const bucketKey = dayKeyOf(atMs)
          const bucket = summary.days[bucketKey] ?? (summary.days[bucketKey] = { t: 0, r: 0, c: 0 })
          bucket.t += delta
          bucket.r += 1
          bucket.c += spend
          bumpBucket(summary.hours, hourKeyOf(atMs), delta, spend)
          bumpBucket(summary.minutes, minuteKeyOf(atMs), delta, spend)
        }
        break
      }
      default:
        break
    }
  }
  return summary
}

/** In-memory parse cache: absolute log path -> { size, mtimeMs, summary }. */
const parseCache = new Map()

/** Load the persisted cache once, tolerating a missing or stale document. */
let cacheLoaded = false
function loadCache() {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8'))
    if (!parsed || parsed.version !== CACHE_VERSION || typeof parsed.entries !== 'object') return
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (value && typeof value.size === 'number' && typeof value.mtimeMs === 'number' && value.summary) {
        parseCache.set(key, value)
      }
    }
  } catch {
    // No cache yet, or an unreadable one: a full rescan is the safe answer.
  }
}

/** Persist the cache; failures are non-fatal. */
function saveCache() {
  try {
    mkdirSync(join(dshHome(), 'dsh-session-usage'), { recursive: true })
    const entries = {}
    for (const [key, value] of parseCache) entries[key] = value
    writeFileSync(cachePath(), JSON.stringify({ version: CACHE_VERSION, entries }))
  } catch {
    // A cache that cannot be written only costs the next scan.
  }
}

/** Yield to the event loop so one long scan cannot starve the host. */
function breathe() {
  return new Promise(resolve => setImmediate(resolve))
}

/** List every session log under the store. */
function listSessionFiles() {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const files = []
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let sessions
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const file = join(projectDir, session.name, SESSION_FILE)
      files.push({ file, key: project.name + '/' + session.name })
    }
  }
  return files
}

/** Turn one cached summary into a wire record. */
function toRecord(key, summary) {
  const cwd = summary.cwd
  const title = summary.title
    || (summary.firstUser ? summary.firstUser.replace(/\s+/g, ' ').slice(0, 60) : null)
    || '未命名对话'
  const lastAt = summary.lastAt
  return {
    key,
    sessionId: key.split('/')[1] ?? key,
    title,
    project: cwd ? basename(cwd) || cwd : '未知项目',
    cwd: cwd ?? null,
    delegationDepth: summary.delegationDepth,
    provider: summary.provider,
    model: summary.model,
    requests: summary.requests,
    turns: summary.turns,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    cacheReadTokens: summary.cacheReadTokens,
    cacheWriteTokens: summary.cacheWriteTokens,
    totalTokens: summary.totalTokens,
    spendCny: summary.spendCny ?? 0,
    days: summary.days ?? {},
    minutes: summary.minutes ?? {},
    hours: summary.hours ?? {},
    createdAt: summary.firstAt,
    lastAt,
  }
}

/**
 * Scan the session store and return every conversation summary.
 * @param {{ force?: boolean }} options force re-parses changed files anyway
 * @returns {Promise<object>} the report payload
 */
async function buildReport(options = {}) {
  loadCache()
  const force = options.force === true
  const files = listSessionFiles()
  const seen = new Set()
  const records = []
  let changed = force

  for (const entry of files) {
    seen.add(entry.file)
    let stat
    try {
      stat = statSync(entry.file)
    } catch {
      continue
    }
    const cached = parseCache.get(entry.file)
    const fresh = cached
      && cached.size === stat.size
      && cached.mtimeMs === stat.mtimeMs
      && !force
    if (!fresh) {
      try {
        const summary = parseSession(entry.file)
        parseCache.set(entry.file, { size: stat.size, mtimeMs: stat.mtimeMs, summary })
        changed = true
        await breathe()
      } catch {
        if (cached) parseCache.set(entry.file, { ...cached, size: stat.size, mtimeMs: stat.mtimeMs })
        continue
      }
    }
    const stored = parseCache.get(entry.file)
    if (stored && stored.summary) records.push(toRecord(entry.key, stored.summary))
  }

  // A conversation deleted from the store must not linger in the cache.
  for (const key of [...parseCache.keys()]) {
    if (!seen.has(key)) {
      parseCache.delete(key)
      changed = true
    }
  }
  if (changed) saveCache()

  records.sort((left, right) => {
    if (right.totalTokens !== left.totalTokens) return right.totalTokens - left.totalTokens
    return (right.lastAt ?? 0) - (left.lastAt ?? 0)
  })

  const totals = {
    sessions: records.filter(record => record.delegationDepth === 0).length,
    subagentSessions: records.filter(record => record.delegationDepth > 0).length,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    spendCny: 0,
  }
  for (const record of records) {
    totals.requests += record.requests
    totals.inputTokens += record.inputTokens
    totals.outputTokens += record.outputTokens
    totals.cacheReadTokens += record.cacheReadTokens
    totals.cacheWriteTokens += record.cacheWriteTokens
    totals.totalTokens += record.totalTokens
    totals.spendCny += record.spendCny
  }

  return {
    ok: true,
    generatedAt: Date.now(),
    todayKey: dayKeyOf(Date.now()),
    now: Date.now(),
    currency: 'CNY',
    sessionsRoot: sessionsRoot(),
    totals,
    workspaces: readWorkspaces(),
    sessions: records,
  }
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** Whether the caller comes from this machine. */
function isLocalRequest(req) {
  const address = req.socket && req.socket.remoteAddress
  if (!address) return false
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address === 'localhost'
}

/** One in-flight report so concurrent requests share a single scan. */
let inFlight = null

/**
 * Record that a browser (not a probe) reached the API. The client half calls this
 * route as soon as it mounts, so a fresh timestamp proves both halves are live.
 * @param {object} req incoming request
 */
function markClientHit(req) {
  const agent = String((req.headers && req.headers['user-agent']) || '')
  // Headless probes and curl do not look like the app's own webview.
  if (!/Mozilla|Electron|Chrome/i.test(agent)) return
  try {
    mkdirSync(join(dshHome(), 'dsh-session-usage'), { recursive: true })
    writeFileSync(
      join(dshHome(), 'dsh-session-usage', 'client-hit.json'),
      JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        origin: String((req.headers && req.headers.origin) || ''),
        ref: String((req.headers && req.headers.referer) || ''),
      }) + '\n',
    )
  } catch {
    // Diagnostic only.
  }
}

/** Serialize scans: a second request waits for the running one. */
function report(options) {
  if (inFlight) return inFlight
  inFlight = buildReport(options).finally(() => {
    inFlight = null
  })
  return inFlight
}

/** The list route: every conversation's token consumption. */
function listRoute() {
  return {
    kind: 'exact',
    path: API_PREFIX + '/list',
    handler: async (req, res) => {
      if (!isLocalRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const force = url.searchParams.get('refresh') === '1'
      markClientHit(req)
      try {
        writeJson(res, 200, await report({ force }))
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}

/**
 * Host body: mount the API routes and warm the parse cache in the background so
 * the first page open is instant.
 * @param {object} ctx host root context
 */
export function apply(ctx) {
  writeMarker('apply-start')
  let disposers = []
  try {
    disposers = [listRoute()].map(route => ctx.webServer.register(route))
  } catch (error) {
    writeMarker('register-failed', { error: error instanceof Error ? error.stack : String(error) })
    throw error
  }
  writeMarker('routes-registered')
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Route already gone.
      }
    }
  }, 'dsh-session-usage: routes')

  // Warm the cache after boot so the settings page does not pay the full scan.
  const timer = setTimeout(() => {
    report({ force: false }).catch(() => {})
  }, 8000)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(() => () => clearTimeout(timer), 'dsh-session-usage: warm')
}
