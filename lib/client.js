/**
 * dsh-session-usage — browser half.
 *
 * Seats one first-level settings section ("对话用量") that renders every
 * recorded conversation with its token consumption, read from the host's
 * `/api/dsh-session-usage/list` route. The host half owns all log parsing; this
 * bundle only renders the report.
 *
 * Written as a hand-authored client module: the repo's client module host loads
 * it through `window.__ModuleLoader__`, so no build step is involved.
 *
 * @module dsh-session-usage/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-usage',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Locale namespace of the section. */
    const NS = 'dsh-session-usage'

    /** Slot this section registers into, and its nav row id. */
    const SETTINGS_SECTION = 'settings.section'
    const SECTION_ID = 'dsh-session-usage'

    /** Nav position: directly below the usage statistics section (151). */
    const SECTION_ORDER = 152

    /** Host API path (document-relative: the GUI is served with `<base href="./">`). */
    const LIST_PATH = 'api/dsh-session-usage/list'

    /** Ceiling for one report fetch: a full cold scan takes a few seconds. */
    const FETCH_TIMEOUT_MS = 120000

    // ---------------------------------------------------------------- format

    /** Compact token counts: 1234 -> 1.2k, 1.2e6 -> 1.2M. */
    function shortNumber(value) {
      const n = Number(value) || 0
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k'
      if (n >= 1e3) return (n / 1e3).toFixed(2) + 'k'
      return String(n)
    }

    /** Exact token counts with thousands separators. */
    function fullNumber(value) {
      const n = Number(value) || 0
      try {
        return n.toLocaleString('en-US')
      } catch {
        return String(n)
      }
    }

    /** `MM-DD HH:mm` for a millisecond timestamp. */
    function stampOf(ms) {
      if (typeof ms !== 'number' || !isFinite(ms)) return '—'
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /** Share of cache reads among all prompt-side tokens, as a percentage. */
    function cacheRateOf(totals) {
      const cache = totals.cacheReadTokens || 0
      const fresh = totals.inputTokens || 0
      const base = cache + fresh
      if (base <= 0) return null
      return (cache / base) * 100
    }

    // ---------------------------------------------------------------- periods

    /** Rolling windows shared by the settings section and the sidebar decoration. */
    const WINDOWS = [
      { id: '10m', label: '10 分钟', short: '10m', ms: 10 * 60 * 1000 },
      { id: '30m', label: '30 分钟', short: '30m', ms: 30 * 60 * 1000 },
      { id: '1h', label: '1 小时', short: '1h', ms: 60 * 60 * 1000 },
      { id: '3h', label: '3 小时', short: '3h', ms: 3 * 60 * 60 * 1000 },
      { id: '1d', label: '1 天', short: '1d', ms: 24 * 60 * 60 * 1000 },
      { id: '7d', label: '7 天', short: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
      { id: '30d', label: '30 天', short: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
      { id: 'all', label: '全部', short: 'all', ms: null },
    ]

    /** Windows up to this length read the per-minute buckets; longer ones read the per-hour buckets. */
    const MINUTE_BUCKET_SPAN_MS = 3 * 60 * 60 * 1000

    const WINDOW_STORAGE_KEY = 'dsh-session-usage.window'
    const WINDOW_EVENT = 'dsh-session-usage:window-change'

    /** The window spec for an id, falling back to one day. */
    function windowOf(id) {
      return WINDOWS.find(entry => entry.id === id) || WINDOWS.find(entry => entry.id === '1d')
    }

    /** Sum one field of every bucket that starts at or after `sinceMs`. */
    function sumBuckets(buckets, unitMs, sinceMs, field) {
      let sum = 0
      for (const key of Object.keys(buckets)) {
        if (Number(key) * unitMs < sinceMs) continue
        sum += Number(buckets[key][field]) || 0
      }
      return sum
    }

    /**
     * One session's tokens (or requests) inside a rolling window.
     * @param {object} session wire record from the host
     * @param {string} windowId one of the WINDOWS ids
     * @param {number} nowMs the host clock, so every row shares one "now"
     * @param {'t' | 'r'} field bucket field
     */
    function usageInWindow(session, windowId, nowMs, field = 't') {
      const spec = windowOf(windowId)
      if (spec.ms === null) {
        if (field === 'r') return Number(session.requests) || 0
        return Number(session.totalTokens) || 0
      }
      const since = Number(nowMs) - spec.ms
      if (spec.ms <= MINUTE_BUCKET_SPAN_MS) return sumBuckets(session.minutes || {}, 60000, since, field)
      return sumBuckets(session.hours || {}, 3600000, since, field)
    }

    /** One session's spend (CNY) inside a rolling window. */
    function costInWindow(session, windowId, nowMs) {
      const spec = windowOf(windowId)
      if (spec.ms === null) return Number(session.spendCny) || 0
      const since = Number(nowMs) - spec.ms
      if (spec.ms <= MINUTE_BUCKET_SPAN_MS) return sumBuckets(session.minutes || {}, 60000, since, 'c')
      return sumBuckets(session.hours || {}, 3600000, since, 'c')
    }

    /** A CNY amount with a precision that stays readable from ¥0.001 to ¥1000. */
    function formatCny(value) {
      const n = Number(value) || 0
      if (n <= 0) return '¥0'
      if (n >= 100) return '¥' + n.toFixed(0)
      if (n >= 1) return '¥' + n.toFixed(2)
      if (n >= 0.01) return '¥' + n.toFixed(3)
      return '¥' + n.toFixed(4)
    }

    /** Window currently stored on this machine. */
    function readStoredWindow() {
      try {
        const value = window.localStorage.getItem(WINDOW_STORAGE_KEY)
        if (value && WINDOWS.some(entry => entry.id === value)) return value
      } catch {
        // Storage disabled: fall through to the default.
      }
      return '1d'
    }

    /** Store the window and tell every listener (panel and sidebar) at once. */
    function storeWindow(id) {
      try {
        window.localStorage.setItem(WINDOW_STORAGE_KEY, id)
      } catch {
        // Storage disabled: the in-memory state still moves.
      }
      try {
        window.dispatchEvent(new CustomEvent(WINDOW_EVENT, { detail: id }))
      } catch {
        // A document without CustomEvent keeps the previous behaviour.
      }
    }

    /** Shared window state. */
    function useWindow() {
      const [win, setWin] = React.useState(readStoredWindow)
      React.useEffect(() => {
        const onChange = () => setWin(readStoredWindow())
        window.addEventListener(WINDOW_EVENT, onChange)
        window.addEventListener('storage', onChange)
        return () => {
          window.removeEventListener(WINDOW_EVENT, onChange)
          window.removeEventListener('storage', onChange)
        }
      }, [])
      const update = React.useCallback((id) => {
        storeWindow(id)
        setWin(id)
      }, [])
      return [win, update]
    }

    /** What the numbers mean: raw token counts, or the CNY estimate for them. */
    const MODES = [{ id: 'tokens', label: 'Token 用量' }, { id: 'cost', label: '费用' }]

    /** Persisted view mode, shared by the panel and the sidebar decoration. */
    const MODE_STORAGE_KEY = 'dsh-session-usage.mode'
    const MODE_EVENT = 'dsh-session-usage:mode-change'

    /** Mode currently stored on this machine. */
    function readStoredMode() {
      try {
        const value = window.localStorage.getItem(MODE_STORAGE_KEY)
        if (value && MODES.some(entry => entry.id === value)) return value
      } catch {
        // Storage disabled: fall through to the default.
      }
      return 'tokens'
    }

    /** Store the mode and tell every listener (panel and sidebar) at once. */
    function storeMode(id) {
      try {
        window.localStorage.setItem(MODE_STORAGE_KEY, id)
      } catch {
        // Storage disabled: the in-memory state still moves.
      }
      try {
        window.dispatchEvent(new CustomEvent(MODE_EVENT, { detail: id }))
      } catch {
        // A document without CustomEvent keeps the previous behaviour.
      }
    }

    /** Shared mode state. */
    function useMode() {
      const [mode, setMode] = React.useState(readStoredMode)
      React.useEffect(() => {
        const onChange = () => setMode(readStoredMode())
        window.addEventListener(MODE_EVENT, onChange)
        window.addEventListener('storage', onChange)
        return () => {
          window.removeEventListener(MODE_EVENT, onChange)
          window.removeEventListener('storage', onChange)
        }
      }, [])
      const update = React.useCallback((id) => {
        storeMode(id)
        setMode(id)
      }, [])
      return [mode, update]
    }

    // ------------------------------------------------------------------ http

    /** Read the host report; `force` makes the host re-parse changed logs. */
    async function fetchReport(force) {
      const url = LIST_PATH + (force ? '?refresh=1' : '')
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!response.ok) throw new Error('请求失败：HTTP ' + response.status)
      const body = await response.json()
      if (!body || body.ok !== true) throw new Error((body && body.error) || '响应格式异常')
      return body
    }

    // ----------------------------------------------------------------- styles

    const BORDER = '1px solid var(--dsh-border-color, rgba(128, 128, 128, 0.22))'
    const ACCENT = '#5b8def'
    const MUTED = { opacity: 0.62 }

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '4px 2px 28px',
        fontSize: '13px',
        color: 'inherit',
      },
      headerRow: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '12px',
        flexWrap: 'wrap',
      },
      title: { fontSize: '15px', fontWeight: 600, lineHeight: 1.4 },
      subtitle: { fontSize: '12px', lineHeight: 1.5, marginTop: '2px', ...MUTED },
      toolbar: { display: 'flex', alignItems: 'center', gap: '8px' },
      updated: { fontSize: '11.5px', ...MUTED },
      button: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 12px',
        borderRadius: '8px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      statGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))',
        gap: '10px',
      },
      statCard: { border: BORDER, borderRadius: '10px', padding: '10px 12px' },
      statLabel: { fontSize: '11px', lineHeight: 1.4, ...MUTED },
      statValue: {
        fontSize: '19px',
        fontWeight: 600,
        lineHeight: 1.35,
        fontVariantNumeric: 'tabular-nums',
      },
      filters: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      select: {
        font: 'inherit',
        fontSize: '12px',
        padding: '4px 8px',
        borderRadius: '8px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
      },
      check: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', cursor: 'pointer' },
      periodRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      periodButton: {
        font: 'inherit',
        fontSize: '12px',
        padding: '3px 12px',
        borderRadius: '999px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        ...MUTED,
      },
      periodButtonActive: {
        borderColor: ACCENT,
        color: ACCENT,
        opacity: 1,
        fontWeight: 600,
      },
      periodHint: { fontSize: '11.5px', ...MUTED },
      periodSep: { width: '1px', height: '14px', background: 'rgba(128,128,128,0.28)', margin: '0 3px' },
      list: { display: 'flex', flexDirection: 'column', gap: '8px' },
      row: {
        border: BORDER,
        borderRadius: '10px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      rowHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' },
      rowTitle: {
        fontSize: '13px',
        fontWeight: 600,
        lineHeight: 1.45,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      },
      rowTokens: {
        fontSize: '14px',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      badge: {
        fontSize: '10px',
        fontWeight: 400,
        padding: '0 6px',
        lineHeight: '16px',
        borderRadius: '999px',
        border: BORDER,
        ...MUTED,
        flex: 'none',
      },
      meta: { fontSize: '11.5px', display: 'flex', gap: '10px', flexWrap: 'wrap', ...MUTED },
      breakdown: { fontSize: '11.5px', display: 'flex', gap: '12px', flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' },
      bar: { height: '3px', borderRadius: '2px', background: 'rgba(128, 128, 128, 0.2)', overflow: 'hidden' },
      barFill: { height: '100%', borderRadius: '2px', background: ACCENT, opacity: 0.75 },
      detail: {
        marginTop: '2px',
        paddingTop: '8px',
        borderTop: BORDER,
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        fontSize: '11.5px',
      },
      detailLine: { display: 'flex', gap: '8px', alignItems: 'baseline' },
      detailKey: { flex: 'none', width: '56px', ...MUTED },
      detailValue: { wordBreak: 'break-word', lineHeight: 1.55 },
      empty: { border: BORDER, borderRadius: '10px', padding: '18px', textAlign: 'center', ...MUTED },
      error: { border: BORDER, borderRadius: '10px', padding: '14px', lineHeight: 1.6 },
      errorText: { fontSize: '12px', wordBreak: 'break-word' },
      skeleton: {
        border: BORDER,
        borderRadius: '10px',
        padding: '12px',
        fontSize: '12px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        ...MUTED,
      },
      dot: {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: ACCENT,
        animation: 'dsh-session-usage-pulse 1.1s ease-in-out infinite',
        flex: 'none',
      },
    }

    /** One keyframe: the pulse used by the loading dot. */
    const KEYFRAMES = '@keyframes dsh-session-usage-pulse { 0%, 100% { opacity: 0.25 } 50% { opacity: 1 } }'

    /** Inject the keyframes once per document. */
    let keyframesInjected = false
    function ensureKeyframes() {
      if (keyframesInjected || typeof document === 'undefined') return
      keyframesInjected = true
      const style = document.createElement('style')
      style.setAttribute('data-dsh-session-usage', '')
      style.textContent = KEYFRAMES
      document.head.appendChild(style)
    }

    // -------------------------------------------------------------- component

    /** One statistic tile. */
    function StatCard(props) {
      return h('div', { style: styles.statCard },
        h('div', { style: styles.statLabel }, props.label),
        h('div', { style: styles.statValue }, props.value),
      )
    }

    /** One conversation row, expandable for its exact breakdown. */
    function SessionRow(props) {
      const session = props.session
      const share = props.share
      const tokens = Number(props.tokens) || 0
      const requests = Number(props.requests) || 0
      const cost = Number(props.cost) || 0
      const costMode = props.mode === 'cost'
      const [open, setOpen] = React.useState(false)
      const isSub = Number(session.delegationDepth) > 0
      const head = h('div', {
        style: Object.assign({}, styles.rowHead, { cursor: 'pointer' }),
        onClick: () => setOpen(v => !v),
        title: '点击展开明细',
      },
        h('div', { style: styles.rowTitle },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, session.title || '未命名对话'),
          isSub ? h('span', { style: styles.badge }, '子任务') : null,
        ),
        h('div', { style: styles.rowTokens }, costMode ? formatCny(cost) + ' / ' + shortNumber(tokens) + ' tokens' : shortNumber(tokens) + ' tokens'),
      )

      const meta = h('div', { style: styles.meta },
        h('span', null, session.project || '未知项目'),
        h('span', null, stampOf(session.lastAt)),
        h('span', null, String(requests) + ' 次请求'),
        h('span', null, (Number(session.turns) || 0) + ' 轮对话'),
      )

      const breakdown = h('div', { style: styles.breakdown },
        props.scoped ? h('span', null, '本时段 ' + shortNumber(tokens)) : null,
        h('span', null, (props.scoped ? '累计 ' : '') + shortNumber(session.totalTokens)),
        h('span', null, '输入 ' + shortNumber(session.inputTokens)),
        h('span', null, '缓存读 ' + shortNumber(session.cacheReadTokens)),
        Number(session.cacheWriteTokens) > 0 ? h('span', null, '缓存写 ' + shortNumber(session.cacheWriteTokens)) : null,
        h('span', null, '输出 ' + shortNumber(session.outputTokens)),
        h('span', null, '费用 ' + formatCny(cost)),
      )

      const bar = h('div', { style: styles.bar },
        h('div', {
          style: Object.assign({}, styles.barFill, { width: Math.max(share * 100, share > 0 ? 1.5 : 0) + '%' }),
        }),
      )

      const detail = open ? h('div', { style: styles.detail },
        h('div', { style: styles.detailLine },
          h('span', { style: styles.detailKey }, '标题'),
          h('span', { style: styles.detailValue }, session.title || '未命名对话'),
        ),
        h('div', { style: styles.detailLine },
          h('span', { style: styles.detailKey }, '本时段'),
          h('span', { style: styles.detailValue },
            fullNumber(tokens) + ' tokens · ' + fullNumber(requests) + ' 次请求 · 约 ' + formatCny(cost)),
        ),
        h('div', { style: styles.detailLine },
          h('span', { style: styles.detailKey }, '累计'),
          h('span', { style: styles.detailValue },
            fullNumber(session.totalTokens) + ' tokens（输入 ' + fullNumber(session.inputTokens)
            + ' · 缓存读 ' + fullNumber(session.cacheReadTokens)
            + ' · 缓存写 ' + fullNumber(session.cacheWriteTokens)
            + ' · 输出 ' + fullNumber(session.outputTokens) + '）'),
        ),
        h('div', { style: styles.detailLine },
          h('span', { style: styles.detailKey }, '模型'),
          h('span', { style: styles.detailValue },
            (session.provider || '未知') + ' / ' + (session.model || '未知')),
        ),
        h('div', { style: styles.detailLine },
          h('span', { style: styles.detailKey }, '占比'),
          h('span', { style: styles.detailValue }, (share * 100).toFixed(1) + '% 的所选时段用量'),
        ),
        h('div', { style: styles.detailLine },
          h('span', { style: styles.detailKey }, '时间'),
          h('span', { style: styles.detailValue },
            stampOf(session.createdAt) + ' → ' + stampOf(session.lastAt)),
        ),
        session.cwd ? h('div', { style: styles.detailLine },
          h('span', { style: styles.detailKey }, '目录'),
          h('span', { style: styles.detailValue }, session.cwd),
        ) : null,
        h('div', { style: styles.detailLine },
          h('span', { style: styles.detailKey }, '会话'),
          h('span', { style: styles.detailValue }, String(session.sessionId || session.key || '')),
        ),
      ) : null

      return h('div', { style: styles.row }, head, meta, breakdown, bar, detail)
    }

    /** The settings section body. */
    function SessionUsagePanel() {
      ensureKeyframes()
      const [state, setState] = React.useState({ status: 'loading', report: null, error: null, updatedAt: null })
      const [project, setProject] = React.useState('__all__')
      const [includeSub, setIncludeSub] = React.useState(false)
      const [order, setOrder] = React.useState('tokens')
      const [win, setWin] = useWindow()
      const [mode, setMode] = useMode()

      const load = React.useCallback((force) => {
        setState(prev => (prev.status === 'ready' ? prev : { status: 'loading', report: null, error: null, updatedAt: null }))
        fetchReport(force).then(
          (report) => setState({ status: 'ready', report, error: null, updatedAt: Date.now() }),
          (error) => setState({ status: 'error', report: null, error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() }),
        )
      }, [])

      React.useEffect(() => { load(false) }, [load])

      const report = state.report
      const all = (report && Array.isArray(report.sessions)) ? report.sessions : []

      const nowMs = Number(report && report.now) || Date.now()
      const allWindow = windowOf(win).ms === null
      const tokensOf = React.useCallback((session) => usageInWindow(session, win, nowMs, 't'), [win, nowMs])
      const requestsOf = React.useCallback((session) => usageInWindow(session, win, nowMs, 'r'), [win, nowMs])
      const costOf = React.useCallback((session) => costInWindow(session, win, nowMs), [win, nowMs])

      const projects = React.useMemo(() => {
        const seen = new Map()
        for (const session of all) {
          const name = session.project || '未知项目'
          seen.set(name, (seen.get(name) || 0) + tokensOf(session))
        }
        return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(entry => entry[0])
      }, [all, tokensOf])

      const visible = React.useMemo(() => {
        const filtered = all.filter((session) => {
          if (!includeSub && Number(session.delegationDepth) > 0) return false
          if (project !== '__all__' && (session.project || '未知项目') !== project) return false
          // A conversation that used nothing inside the period is out of scope.
          if (!allWindow && tokensOf(session) === 0) return false
          return true
        })
        const sorted = filtered.slice().sort((a, b) => {
          if (order === 'time') return (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0)
          return tokensOf(b) - tokensOf(a)
        })
        return sorted
      }, [all, includeSub, project, order, allWindow, tokensOf])

      const scopeTotals = React.useMemo(() => {
        const totals = { sessions: 0, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, spendCny: 0 }
        for (const session of visible) {
          totals.sessions += 1
          totals.requests += requestsOf(session)
          totals.inputTokens += Number(session.inputTokens) || 0
          totals.outputTokens += Number(session.outputTokens) || 0
          totals.cacheReadTokens += Number(session.cacheReadTokens) || 0
          totals.totalTokens += tokensOf(session)
          totals.spendCny += costOf(session)
        }
        return totals
      }, [visible, tokensOf, requestsOf, costOf])

      const cacheRate = cacheRateOf(scopeTotals)

      const header = h('div', { style: styles.headerRow },
        h('div', null,
          h('div', { style: styles.title }, '对话 Token 用量'),
          h('div', { style: styles.subtitle }, '按会话统计每个对话消耗的 token，数据直接来自本地会话日志，历史上全部对话都在内。'),
        ),
        h('div', { style: styles.toolbar },
          state.updatedAt ? h('span', { style: styles.updatedAt }, '更新于 ' + stampOf(state.updatedAt)) : null,
          h('button', {
            type: 'button',
            style: Object.assign({}, styles.button, state.status === 'loading' ? { opacity: 0.55, cursor: 'default' } : {}),
            disabled: state.status === 'loading',
            onClick: () => { if (state.status !== 'loading') load(true) },
          }, state.status === 'loading' ? '统计中…' : '刷新'),
        ),
      )

      if (state.status === 'loading') {
        return h('div', { style: styles.root },
          header,
          h('div', { style: styles.skeleton }, h('span', { style: styles.dot }), '正在解析会话日志，首次统计需要几秒钟…'),
        )
      }

      if (state.status === 'error') {
        return h('div', { style: styles.root },
          header,
          h('div', { style: styles.error },
            h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } }, '统计失败'),
            h('div', { style: styles.errorText }, state.error || '未知错误'),
            h('div', { style: Object.assign({}, styles.errorText, MUTED, { marginTop: '6px' }) },
              'HTTP 404 通常表示宿主插件没有加载：请确认 dsh-session-usage 已写入当前 profile 并重启客户端。'),
            h('button', {
              type: 'button',
              style: Object.assign({}, styles.button, { marginTop: '10px' }),
              onClick: () => load(true),
            }, '重试'),
          ),
        )
      }

      if (all.length === 0) {
        return h('div', { style: styles.root },
          header,
          h('div', { style: styles.empty }, '没有找到任何会话日志。'),
        )
      }

      return h('div', { style: styles.root },
        header,
        h('div', { style: styles.periodRow },
          WINDOWS.map(choice => h('button', {
            key: choice.id,
            type: 'button',
            style: Object.assign({}, styles.periodButton, win === choice.id ? styles.periodButtonActive : null),
            onClick: () => setWin(choice.id),
          }, choice.label)),
          h('span', { key: '__sep', style: styles.periodSep }),
          MODES.map(choice => h('button', {
            key: choice.id,
            type: 'button',
            style: Object.assign({}, styles.periodButton, mode === choice.id ? styles.periodButtonActive : null),
            onClick: () => setMode(choice.id),
          }, choice.label)),
        ),
        h('div', { style: styles.periodHint },
          '统计时长与统计口径同时作用于下方明细与左侧边栏：对话行标题下是占比进度条，时间左侧是具体用量，工作区行显示其下所有对话的合计；「工作区」标题旁的两个按键分别切换统计时长和 Token 与费用。'),
        h('div', { style: styles.statGrid },
          h(StatCard, { label: '对话数', value: String(scopeTotals.sessions) }),
          h(StatCard, {
            label: mode === 'cost' ? '总费用（估算）' : '总 Token',
            value: mode === 'cost' ? formatCny(scopeTotals.spendCny) : shortNumber(scopeTotals.totalTokens),
          }),
          h(StatCard, { label: '请求数', value: fullNumber(scopeTotals.requests) }),
          h(StatCard, {
            label: allWindow ? '缓存命中率(累计)' : '缓存命中率',
            value: cacheRate === null ? '—' : cacheRate.toFixed(1) + '%',
          }),
        ),
        h('div', { style: styles.filters },
          h('select', {
            style: styles.select,
            value: project,
            onChange: (event) => setProject(event.target.value),
          },
            h('option', { value: '__all__' }, '全部项目'),
            projects.map(name => h('option', { key: name, value: name }, name)),
          ),
          h('select', {
            style: styles.select,
            value: order,
            onChange: (event) => setOrder(event.target.value),
          },
            h('option', { value: 'tokens' }, '按用量排序'),
            h('option', { value: 'time' }, '按时间排序'),
          ),
          h('label', { style: styles.check },
            h('input', {
              type: 'checkbox',
              checked: includeSub,
              onChange: (event) => setIncludeSub(event.target.checked),
            }),
            '包含子任务会话',
          ),
          h('span', { style: Object.assign({}, styles.updated, { marginLeft: 'auto' }) },
            '共 ' + visible.length + ' 条 · 本区间 ' + shortNumber(scopeTotals.totalTokens) + ' tokens · 约 ' + formatCny(scopeTotals.spendCny)
            + (allWindow ? '' : ' · 输入 ' + shortNumber(scopeTotals.inputTokens) + ' · 输出 ' + shortNumber(scopeTotals.outputTokens))),
        ),
        h('div', { style: styles.list },
          visible.map((session) => h(SessionRow, {
            key: session.key || session.sessionId,
            session,
            tokens: tokensOf(session),
            cost: costOf(session),
            mode,
            requests: requestsOf(session),
            scoped: !allWindow,
            share: scopeTotals.totalTokens > 0 ? tokensOf(session) / scopeTotals.totalTokens : 0,
          })),
        ),
      )
    }

    // ------------------------------------------------------ sidebar decoration

    const SIDEBAR_STYLE_ID = 'dsh-session-usage-sidebar'
    const BAR_ACCENT = '#5b8def'

    /** Minimum gap between two paints, so streaming output cannot spin the renderer. */
    const PAINT_MIN_INTERVAL = 250

    /** Mutations watched to keep the decoration in sync with the host sidebar. */
    const OBSERVE_OPTIONS = { childList: true, subtree: true }

    /**
     * The sidebar's session and workspace rows are rendered by the app, not by a
     * slot this plugin can own, so the usage is painted on top of that DOM: the
     * decorator only ever appends its own children and never touches host nodes.
     */
    const SIDEBAR_CSS = [
      '[data-su-row]{position:relative}',
      '[data-su-token]{margin-left:8px;margin-right:6px;font-size:10px;line-height:1.5;font-variant-numeric:tabular-nums;opacity:.45;white-space:nowrap;flex:none;letter-spacing:-.2px}',
      '[data-su-bar]{position:absolute;bottom:0;height:3px;border-radius:2px;background:rgba(128,128,128,.16);overflow:hidden;pointer-events:none}',
      '[data-su-bar]>i{display:block;height:100%;border-radius:2px;background:' + BAR_ACCENT + ';opacity:.85}',
    ].join('')

    /** Inject the sidebar stylesheet once per document. */
    function ensureSidebarStyle() {
      if (typeof document === 'undefined' || document.getElementById(SIDEBAR_STYLE_ID)) return
      const style = document.createElement('style')
      style.id = SIDEBAR_STYLE_ID
      style.textContent = SIDEBAR_CSS
      document.head.appendChild(style)
    }

    /** The first direct child whose class contains one of `names`. */
    function childWithClass(node, names) {
      for (const child of node.children) {
        const cls = typeof child.className === 'string' ? child.className : ''
        for (const name of names) if (cls.indexOf(name) >= 0) return child
      }
      return null
    }

    /** The decorator's own child of one kind, if it is attached. */
    function ownChild(node, attribute) {
      for (const child of node.children) {
        if (child.hasAttribute && child.hasAttribute(attribute)) return child
      }
      return null
    }

    /**
     * Keep one usage label at `before`, creating it when missing.
     * @returns {HTMLElement}
     */
    function ensureLabel(node, before, text, tip) {
      let label = ownChild(node, 'data-su-token')
      if (!label) {
        label = document.createElement('span')
        label.setAttribute('data-su-token', '')
        if (before && before.parentNode === node) node.insertBefore(label, before)
        else node.appendChild(label)
      } else if (before && before.parentNode === node && label.nextSibling !== before) {
        node.insertBefore(label, before)
      }
      if (label.textContent !== text) label.textContent = text
      label.title = tip
      return label
    }

    /**
     * Keep one usage bar under the row's label, sized against `ratio`.
     * @param {number} leftPx horizontal start, aligned with the row label
     */
    function ensureBar(node, ratio, leftPx) {
      let bar = ownChild(node, 'data-su-bar')
      if (!bar) {
        bar = document.createElement('div')
        bar.setAttribute('data-su-bar', '')
        bar.appendChild(document.createElement('i'))
        node.appendChild(bar)
      }
      const fill = bar.firstChild
      const width = ratio > 0 ? Math.max(ratio * 100, 1.5) : 0
      const widthStyle = width + '%'
      if (fill.style.width !== widthStyle) fill.style.width = widthStyle
      const leftStyle = Math.max(leftPx, 0) + 'px'
      if (bar.style.left !== leftStyle) bar.style.left = leftStyle
      bar.style.right = '8px'
      return bar
    }

    /**
     * Start painting usage onto the sidebar. Safe to call more than once: the
     * first call owns the decorator and later calls only force a repaint.
     * @returns {() => void} disposer
     */
    function startSidebarDecorator() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
      ensureSidebarStyle()

      const existing = window.__dshSessionUsageSidebar
      if (existing && typeof existing.refresh === 'function') {
        existing.refresh(false)
        return () => {}
      }

      const state = {
        report: null,
        workspaces: [],
        window: readStoredWindow(),
        mode: readStoredMode(),
        sessionTokens: new Map(),
        workspaceTokens: new Map(),
        sessionCost: new Map(),
        workspaceCost: new Map(),
        maxSession: 0,
        maxWorkspace: 0,
        maxSessionCost: 0,
        maxWorkspaceCost: 0,
        frame: 0,
        lastPaint: 0,
        timer: 0,
        poll: 0,
        observer: null,
        disposed: false,
      }

      /** Recompute the period-filtered numbers every row is painted from. */
      const rebuild = () => {
        const nowMs = Number(state.report && state.report.now) || Date.now()
        const sessionTokens = new Map()
        const sessionCost = new Map()
        let maxSession = 0
        let maxSessionCost = 0
        for (const record of (state.report && state.report.sessions) || []) {
          const id = String(record.sessionId || '')
          if (id === '') continue
          const tokens = usageInWindow(record, state.window, nowMs, 't')
          const cost = costInWindow(record, state.window, nowMs)
          sessionTokens.set(id, tokens)
          sessionCost.set(id, cost)
          if (tokens > maxSession) maxSession = tokens
          if (cost > maxSessionCost) maxSessionCost = cost
        }
        const workspaceTokens = new Map()
        const workspaceCost = new Map()
        let maxWorkspace = 0
        let maxWorkspaceCost = 0
        for (const workspace of state.workspaces) {
          let tokens = 0
          let cost = 0
          for (const id of workspace.sessionIds || []) {
            tokens += sessionTokens.get(String(id)) || 0
            cost += sessionCost.get(String(id)) || 0
          }
          workspaceTokens.set(String(workspace.id), tokens)
          workspaceCost.set(String(workspace.id), cost)
          if (tokens > maxWorkspace) maxWorkspace = tokens
          if (cost > maxWorkspaceCost) maxWorkspaceCost = cost
        }
        state.sessionTokens = sessionTokens
        state.workspaceTokens = workspaceTokens
        state.sessionCost = sessionCost
        state.workspaceCost = workspaceCost
        state.maxSession = maxSession
        state.maxWorkspace = maxWorkspace
        state.maxSessionCost = maxSessionCost
        state.maxWorkspaceCost = maxWorkspaceCost
      }

      /** Space the toggles steal from the search slot's left margin. */
      const TOGGLE_GROUP_WIDTH = 52

      /**
       * A small holder for both switches. It sits in the section header right
       * before the action icons, and the width it takes is given back by
       * shrinking the search slot's left margin, so the header keeps its size
       * and the real icons stay visible.
       */
      const ensureToggleGroup = () => {
        const existing = document.querySelector('[data-su-toggles]')
        if (existing) return existing
        const host = document.querySelector('button[aria-label="搜索会话"]')
        if (!host) return null
        const slot = host.closest('[class*=searchSlot]')
        const header = slot && slot.parentNode
        if (!slot || !header) return null
        const group = document.createElement('span')
        group.setAttribute('data-su-toggles', '')
        group.style.display = 'flex'
        group.style.alignItems = 'center'
        group.style.gap = '2px'
        group.style.flex = '0 0 auto'
        const actions = header.querySelector('[class*=headerActions]')
        if (actions) header.insertBefore(group, actions)
        else header.appendChild(group)
        const margin = parseFloat(window.getComputedStyle(slot).marginLeft) || 0
        if (margin > TOGGLE_GROUP_WIDTH + 8) slot.style.marginLeft = margin - TOGGLE_GROUP_WIDTH + 'px'
        return group
      }

      /**
       * The switch in the workspace group header. It borrows the search
       * button's own classes so it looks native, and it is the only control
       * that flips the metric the rows are painted with.
       */
      const ensureModeToggle = () => {
        const costMode = state.mode === 'cost'
        const text = costMode ? '¥' : 'T'
        const tip = costMode
          ? '当前统计口径：费用（CNY 估算）· 点击切换为 Token 用量'
          : '当前统计口径：Token 用量 · 点击切换为费用'
        const existing = document.querySelector('[data-su-mode-toggle]')
        if (existing) {
          if (existing.textContent !== text) existing.textContent = text
          if (existing.getAttribute('title') !== tip) existing.setAttribute('title', tip)
          return
        }
        const group = ensureToggleGroup()
        if (!group) return
        const host = document.querySelector('button[aria-label="搜索会话"]')
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('data-su-mode-toggle', '')
        button.className = host && typeof host.className === 'string' ? host.className : ''
        button.textContent = text
        button.setAttribute('title', tip)
        button.style.fontSize = '11px'
        button.style.lineHeight = '1'
        button.style.padding = '0'
        button.style.width = '22px'
        button.style.height = '22px'
        button.style.flex = 'none'
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          storeMode(readStoredMode() === 'cost' ? 'tokens' : 'cost')
        })
        group.appendChild(button)
      }

      /** The little duration menu is a body-level popup so the sidebar cannot clip it. */
      let menuNode = null

      function closeWindowMenu() {
        document.removeEventListener('mousedown', onMenuOutside, true)
        if (menuNode && menuNode.parentNode) menuNode.parentNode.removeChild(menuNode)
        menuNode = null
      }

      function onMenuOutside(event) {
        if (!menuNode) return
        if (menuNode.contains(event.target)) return
        if (event.target && event.target.closest && event.target.closest('[data-su-window-toggle]')) return
        closeWindowMenu()
      }

      /** Opens the eight rolling windows at once, anchored to the toggle. */
      function openWindowMenu(anchor) {
        closeWindowMenu()
        const rect = anchor.getBoundingClientRect()
        const menu = document.createElement('div')
        menu.setAttribute('data-su-window-menu', '')
        menu.style.position = 'fixed'
        menu.style.zIndex = '2147483000'
        menu.style.minWidth = '104px'
        menu.style.padding = '4px'
        menu.style.borderRadius = '8px'
        menu.style.background = 'Canvas'
        menu.style.color = 'CanvasText'
        menu.style.border = '1px solid rgba(128,128,128,0.35)'
        menu.style.boxShadow = '0 10px 26px rgba(0,0,0,0.18)'
        menu.style.fontSize = '12px'
        menu.style.left = Math.max(8, Math.min(rect.left - 44, window.innerWidth - 130)) + 'px'
        menu.style.top = Math.round(rect.bottom + 6) + 'px'
        const current = readStoredWindow()
        for (const entry of WINDOWS) {
          const item = document.createElement('button')
          item.type = 'button'
          item.textContent = entry.label
          item.style.display = 'block'
          item.style.width = '100%'
          item.style.textAlign = 'left'
          item.style.padding = '5px 8px'
          item.style.border = '0'
          item.style.borderRadius = '6px'
          item.style.background = entry.id === current ? 'rgba(91,141,239,0.18)' : 'transparent'
          item.style.color = 'inherit'
          item.style.fontSize = '12px'
          item.style.cursor = 'pointer'
          item.style.whiteSpace = 'nowrap'
          item.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            storeWindow(entry.id)
            closeWindowMenu()
          })
          menu.appendChild(item)
        }
        document.body.appendChild(menu)
        menuNode = menu
        document.addEventListener('mousedown', onMenuOutside, true)
      }

      /** The duration switch, seated next to the metric switch in the group header. */
      const ensureWindowToggle = () => {
        const spec = windowOf(state.window)
        const text = spec.short
        const tip = '当前统计时长：' + spec.label + ' · 点击选择 10 分钟 / 30 分钟 / 1 小时 / 3 小时 / 1 天 / 7 天 / 30 天 / 全部'
        const existing = document.querySelector('[data-su-window-toggle]')
        if (existing) {
          if (existing.textContent !== text) existing.textContent = text
          if (existing.getAttribute('title') !== tip) existing.setAttribute('title', tip)
          return
        }
        const host = document.querySelector('button[aria-label="搜索会话"]')
        const group = ensureToggleGroup()
        if (!host || !group) return
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('data-su-window-toggle', '')
        button.className = typeof host.className === 'string' ? host.className : ''
        button.textContent = text
        button.setAttribute('title', tip)
        button.style.fontSize = '10px'
        button.style.lineHeight = '1'
        button.style.padding = '0 4px'
        button.style.minWidth = '24px'
        button.style.height = '22px'
        button.style.flex = 'none'
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (menuNode) closeWindowMenu()
          else openWindowMenu(button)
        })
        if (group.firstChild) group.insertBefore(button, group.firstChild)
        else group.appendChild(button)
      }

      /** Paint every sidebar row currently mounted. */
      const paint = () => {
        if (state.disposed) return
        ensureWindowToggle()
        ensureModeToggle()
        const rows = document.querySelectorAll('[data-row-key]')
        for (const row of rows) {
          const key = row.getAttribute('data-row-key') || ''
          const cls = typeof row.className === 'string' ? row.className : ''
          const isSession = cls.indexOf('sessionRow') >= 0
          const isWorkspace = !isSession && cls.indexOf('projectRow') >= 0
          if (!isSession && !isWorkspace) continue
          // Session rows carry the label directly; a workspace row nests its title
          // inside the text wrapper, so that wrapper is the row label instead.
          const label = childWithClass(row, ['title']) || childWithClass(row, ['projectText'])
          if (!label) continue

          const id = key.slice(key.indexOf(':') + 1)
          const costMode = state.mode === 'cost'
          const tokens = isSession
            ? (state.sessionTokens.get(id) || 0)
            : (state.workspaceTokens.get(id) || 0)
          const cost = isSession
            ? (state.sessionCost.get(id) || 0)
            : (state.workspaceCost.get(id) || 0)
          const peak = costMode
            ? (isSession ? state.maxSessionCost : state.maxWorkspaceCost)
            : (isSession ? state.maxSession : state.maxWorkspace)
          const value = costMode ? cost : tokens
          const ratio = peak > 0 ? value / peak : 0
          const amount = costMode ? formatCny(cost) : (tokens > 0 ? shortNumber(tokens) : '0')
          const tip = (isSession ? '本周期：' : '该工作区本周期合计：')
            + (tokens > 0 ? shortNumber(tokens) : '0') + ' tokens · 约 ' + formatCny(cost)
            + '（' + (isSession ? fullNumber(tokens) + ' tokens' : '含其下全部对话') + '）'

          if (row.getAttribute('data-su-row') !== '1') row.setAttribute('data-su-row', '1')
          // The label sits left of the row's own trailing metadata (time / actions).
          const anchor = isSession
            ? (childWithClass(row, ['time']) || childWithClass(row, ['rowActions']))
            : childWithClass(row, ['rowActions'])
          ensureLabel(row, anchor, amount, tip)
          ensureBar(row, ratio, label.offsetLeft || 0)
        }
      }

      /** Coalesce repaints into one frame, no faster than once per interval. */
      const schedule = () => {
        if (state.disposed || state.frame !== 0) return
        const run = () => {
          state.frame = 0
          if (state.disposed) return
          // A streaming reply mutates the tree thousands of times per second;
          // never paint a hidden tab and never paint faster than the interval.
          if (document.hidden) return
          const wait = PAINT_MIN_INTERVAL - (Date.now() - state.lastPaint)
          if (wait > 0) {
            state.frame = window.setTimeout(run, wait)
            return
          }
          state.lastPaint = Date.now()
          // Ignore the mutations our own painting produces so it cannot re-trigger itself.
          if (state.observer) state.observer.disconnect()
          try {
            paint()
          } catch {
            // A DOM shape this plugin does not understand must never break the app.
          } finally {
            if (!state.disposed && state.observer) state.observer.observe(document.body, OBSERVE_OPTIONS)
          }
        }
        if (typeof window.requestAnimationFrame === 'function') state.frame = window.requestAnimationFrame(run)
        else state.frame = window.setTimeout(run, 16)
      }

      /** Load the report and repaint. */
      const refresh = (force) => {
        if (state.disposed) return
        fetchReport(force === true).then(
          (report) => {
            if (state.disposed) return
            state.report = report
            state.workspaces = Array.isArray(report.workspaces) ? report.workspaces : []
            rebuild()
            schedule()
          },
          () => {
            // Host half not mounted (or a scan collision): try again on the next poll.
          },
        )
      }

      /** A period change only needs the buckets re-summed, not a new scan. */
      const onWindowChange = () => {
        if (state.disposed) return
        state.window = readStoredWindow()
        rebuild()
        schedule()
      }

      /** A metric change repaints from the numbers already in hand. */
      const onModeChange = () => {
        if (state.disposed) return
        state.mode = readStoredMode()
        rebuild()
        schedule()
      }

      state.refresh = refresh
      window.__dshSessionUsageSidebar = state

      const observer = typeof MutationObserver === 'function'
        ? new MutationObserver(() => schedule())
        : null
      if (observer) observer.observe(document.body, OBSERVE_OPTIONS)
      state.observer = observer

      window.addEventListener(WINDOW_EVENT, onWindowChange)
      window.addEventListener('storage', onWindowChange)
      window.addEventListener(MODE_EVENT, onModeChange)
      window.addEventListener('storage', onModeChange)
      window.addEventListener('focus', () => refresh(false))
      const onVisible = () => schedule()
      window.addEventListener('visibilitychange', onVisible)

      state.timer = window.setInterval(() => refresh(false), 60000)
      state.poll = window.setInterval(() => schedule(), 4000)
      refresh(false)

      return () => {
        state.disposed = true
        if (state.frame !== 0 && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(state.frame)
        window.clearInterval(state.timer)
        window.clearInterval(state.poll)
        if (state.observer) state.observer.disconnect()
        window.removeEventListener(WINDOW_EVENT, onWindowChange)
        window.removeEventListener('storage', onWindowChange)
        window.removeEventListener(MODE_EVENT, onModeChange)
        window.removeEventListener('storage', onModeChange)
        window.removeEventListener('visibilitychange', onVisible)
        closeWindowMenu()
        for (const node of document.querySelectorAll('[data-su-token],[data-su-bar],[data-su-mode-toggle],[data-su-window-toggle],[data-su-window-menu],[data-su-toggles]')) node.remove()
        const slot = document.querySelector('[class*=searchSlot]')
        if (slot) slot.style.marginLeft = ''
        if (window.__dshSessionUsageSidebar === state) delete window.__dshSessionUsageSidebar
      }
    }

    // ------------------------------------------------------------- mounting

    /** Read an optional service from the client context without throwing. */
    function serviceOf(ctx, name) {
      if (!ctx || typeof ctx.get !== 'function') return undefined
      try {
        const value = ctx.get(name)
        return value && typeof value === 'object' ? value : undefined
      } catch {
        return undefined
      }
    }

    /** Locale dictionaries; the nav label resolves through ctx.locale. */
    const dictionaries = {
      zh: { 'dsh-session-usage.title': '对话用量' },
      en: { 'dsh-session-usage.title': 'Conversation usage' },
    }

    /**
     * Register the section on the settings slot, retrying once the slot exists.
     * @param {object} ctx client root context
     * @param {string} label localized nav label provider
     * @returns {() => void} disposer
     */
    function installSection(ctx, label) {
      let dispose
      let mounted = false
      const mount = () => {
        if (mounted || !ctx.slots) return
        try {
          if (typeof ctx.slots.spec === 'function' && ctx.slots.spec(SETTINGS_SECTION) === undefined) return
          dispose = ctx.slots.register({
            name: SETTINGS_SECTION,
            id: SECTION_ID,
            order: SECTION_ORDER,
            label,
            locale: NS,
            inject: () => ({}),
          }, SessionUsagePanel)
          mounted = true
        } catch (error) {
          // The loader may evaluate this bundle twice (combo row plus its own row) or
          // re-apply the plugin on a hot swap. A row that is already seated under our
          // id is the desired end state, not a mount failure.
          const message = error && typeof error.message === 'string' ? error.message : ''
          if (message.includes('already has an entry with id')) {
            mounted = true
            return
          }
          console.warn('[dsh-session-usage] section mount failed', error)
        }
      }
      mount()
      if (!mounted && typeof ctx.on === 'function') {
        try {
          ctx.on('slots/changed', () => { if (!mounted) mount() })
        } catch {
          // Without the change feed the first attempt is all we get.
        }
      }
      return () => {
        if (typeof dispose === 'function') {
          try {
            dispose()
          } catch {
            // Already disposed.
          }
        }
        mounted = false
      }
    }

    /** Required services. */
    const inject = ['slots', 'locale']

    /**
     * Client plugin body: register the dictionary and seat the section.
     * @param {object} ctx client root context
     */
    function apply(ctx) {
      if (ctx && ctx.locale && typeof ctx.locale.register === 'function') {
        try {
          ctx.locale.register('dsh-session-usage', dictionaries)
        } catch {
          // A locale host that refuses the dictionary still gets a literal label.
        }
      }

      const label = () => {
        try {
          const translate = ctx.locale.bind('dsh-session-usage')
          const value = translate('dsh-session-usage.title')
          return typeof value === 'string' && value !== '' ? value : '对话用量'
        } catch {
          return '对话用量'
        }
      }

      const dispose = installSection(ctx, label)
      const stopDecorator = startSidebarDecorator()
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          try {
            dispose()
          } catch {
            // Section already gone.
          }
          try {
            stopDecorator()
          } catch {
            // Sidebar decoration already gone.
          }
        }, 'dsh-session-usage: settings section and sidebar decoration')
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
