import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentStat, Limit, DashSettings, Tokens, Usage } from '../types'

const PANE = 'token-dash'
const TITLE = 'Token Dash'
// Burn rate is averaged over this window (or the agent's age, if younger).
const WINDOW_MS = 120_000
// An agent younger than this is never auto-killed: its first request is a spike.
const GRACE_MS = 30_000
const MAX_AGENTS = 30
const STEP = 5_000

const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

// Bump a shape tag when that value's fields change.
const now = atom({ plugin: 'token-dash', key: 'now' } as const, 0)
const usage = atom(
  { plugin: 'token-dash', key: 'usage' } as const,
  { contextWindow: 0, limits: [], main: ZERO } as Usage,
  { shape: 'usage-1' },
)
const agents = atom(
  { plugin: 'token-dash', key: 'agents' } as const,
  {} as Record<string, AgentStat>,
  { shape: 'agents-1' },
)
const settings = atom(
  { plugin: 'token-dash', key: 'settings' } as const,
  { threshold: 20_000, autoKill: false } as DashSettings,
)

type Usage4 = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const add = (t: Tokens, u: Usage4): Tokens => ({
  input: t.input + u.input_tokens,
  output: t.output + u.output_tokens,
  cacheRead: t.cacheRead + u.cache_read_input_tokens,
  cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
})

// Tokens that count toward burn: cache reads are left out, as they are far
// cheaper against usage limits and would swamp every other figure.
const burned = (u: Usage4) =>
  u.input_tokens + u.output_tokens + u.cache_creation_input_tokens

const total = (t: Tokens) => t.input + t.output + t.cacheWrite

export function burnRate(agent: AgentStat, at: number): number {
  const recent = agent.samples.filter(s => at - s.at <= WINDOW_MS)
  const sum = recent.reduce((n, s) => n + s.tokens, 0)
  const span = Math.min(WINDOW_MS, Math.max(15_000, at - agent.firstSeen))

  return (sum / span) * 60_000
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`

  return String(Math.round(n))
}

export function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`
  if (h > 0) return `${h}h ${pad(m)}m ${pad(sec)}s`

  return `${m}m ${pad(sec)}s`
}

function shortCountdown(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m >= 1440) return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`
  if (m >= 60) return `${Math.floor(m / 60)}h${m % 60}m`

  return `${m}m`
}

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: '7-day',
  seven_day_opus: '7-day Opus',
  seven_day_sonnet: '7-day Sonnet',
  spend_limit: 'Spend',
}
const limitName = (kind: string) => LIMIT_NAMES[kind] ?? kind
const limitShort = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : limitName(kind)

function bar(percent: number, width: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const pctColor = (p: number) => (p >= 90 ? 'red' : p >= 70 ? 'yellow' : 'green')

function summarize(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const v = input[key]
    if (typeof v === 'string' && v.length > 0) {
      const one = v.replace(/\s+/g, ' ').trim()

      return one.length > 60 ? `${one.slice(0, 57)}...` : one
    }
  }

  return ''
}

function blankAgent(id: string, at: number): AgentStat {
  return {
    id,
    description: '',
    type: '',
    status: 'running',
    firstSeen: at,
    activity: 'starting',
    tokens: ZERO,
    samples: [],
    killRequested: false,
  }
}

const isLive = (status: string) =>
  status === 'running' || status === 'pending' || status === 'waiting'

async function kill($: EngineInterface, id: string, why: string) {
  await update($, agents, map =>
    map[id] ? { ...map, [id]: { ...map[id], killRequested: true } } : map,
  )
  const ran = await $.tool
    .call({ tool: 'TaskStop', task_id: id })
    .catch((err: unknown) => ({ deny: String(err), isError: undefined, text: undefined }))
  const failure = ran.deny ?? (ran.isError ? ran.text : undefined)
  const name = (await read($, agents))[id]?.description || id

  if (failure !== undefined) {
    await update($, agents, map =>
      map[id] ? { ...map, [id]: { ...map[id], killRequested: false } } : map,
    )
    $.ui.toast(`Could not stop "${name}": ${failure}`)

    return
  }
  await update($, agents, map =>
    map[id] ? { ...map, [id]: { ...map[id], status: 'killed' } } : map,
  )
  $.ui.toast(`Stopped "${name}" (${why})`)
}

let lastStatus: string | undefined

async function tick($: EngineInterface) {
  const at = await $.clock.now()
  await update($, now, () => at)

  const fresh = await $.session.usage()
  await update($, usage, u => ({
    ...u,
    contextTokens: fresh.context.tokens,
    contextWindow: fresh.context.window,
    contextPercent: fresh.context.percent,
    costUsd: fresh.cost?.usd,
    limits: fresh.rateLimits.map(l => ({ ...l })),
  }))

  const status = fresh.rateLimits
    .map(l => {
      const reset = l.resetsAt ? ` ↻${shortCountdown(Date.parse(l.resetsAt) - at)}` : ''

      return `${limitShort(l.kind)} ${Math.round(l.percentUsed)}%${reset}`
    })
    .join(' · ')
  if (status !== lastStatus) {
    lastStatus = status
    $.ui.status(status === '' ? undefined : status)
  }

  const listed = await $.agent.list()
  await update($, agents, map => {
    const next: Record<string, AgentStat> = { ...map }
    const seen = new Set<string>()
    for (const info of listed) {
      seen.add(info.id)
      const was = next[info.id] ?? blankAgent(info.id, at)
      next[info.id] = {
        ...was,
        description: info.description,
        type: info.type,
        // Our own "killed" wins until the engine reports a final state.
        status: was.status === 'killed' && isLive(info.status) ? 'killed' : info.status,
      }
    }
    for (const [id, a] of Object.entries(next)) {
      if (!seen.has(id) && isLive(a.status)) next[id] = { ...a, status: 'completed' }
    }
    const ids = Object.keys(next).sort((x, y) => next[y]!.firstSeen - next[x]!.firstSeen)
    for (const id of ids.slice(MAX_AGENTS)) delete next[id]

    return next
  })

  const { threshold, autoKill } = await read($, settings)
  if (!autoKill) return
  for (const a of Object.values(await read($, agents))) {
    const isOld = at - a.firstSeen >= GRACE_MS
    if (isLive(a.status) && !a.killRequested && isOld && burnRate(a, at) > threshold) {
      void kill($, a.id, `burn ${fmtTokens(burnRate(a, at))}/min > ${fmtTokens(threshold)}/min`)
    }
  }
}


async function saveSettings($: EngineInterface, fn: (s: DashSettings) => DashSettings) {
  await update($, settings, fn)
  await $.store.set('settings', await read($, settings))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dash',
      description: 'Open the Token Dash pane: token usage, limit resets, subagents',
    })
    const saved = (await $.store.get('settings')) as Partial<DashSettings> | undefined
    if (saved && typeof saved.threshold === 'number') {
      await update($, settings, s => ({ ...s, ...saved }))
    }
    $.clock.every(1000, () => void tick($).catch(() => undefined))
    void tick($).catch(() => undefined)
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'dash' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Token Dash opened.' }
  })

  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    const u = res.usage
    if (u === null) return res
    const at = await $.clock.now()
    const id = e.agentId
    if (id === undefined) {
      await update($, usage, s => ({ ...s, main: add(s.main, u) }))
    } else {
      await update($, agents, map => {
        const was = map[id] ?? blankAgent(id, at)
        const samples = [...was.samples, { at, tokens: burned(u) }].filter(
          s => at - s.at <= WINDOW_MS,
        )

        return { ...map, [id]: { ...was, tokens: add(was.tokens, u), samples } }
      })
    }

    return res
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const at = await $.clock.now()
      const detail = summarize(e as unknown as Record<string, unknown>)
      const activity = detail ? `${String(e.tool)}: ${detail}` : String(e.tool)
      await update($, agents, map => ({
        ...map,
        [id]: { ...(map[id] ?? blankAgent(id, at)), activity },
      }))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const at = await read($, now)
    const u = await read($, usage)
    const map = await read($, agents)
    const { threshold, autoKill } = await read($, settings)
    const cols = e.props.bodyColumns ?? 60
    const barWidth = Math.max(5, Math.min(20, cols - 40))

    const agentList = Object.values(map).sort((x, y) => {
      const live = Number(isLive(y.status)) - Number(isLive(x.status))

      return live !== 0 ? live : y.firstSeen - x.firstSeen
    })
    const agentTotal = agentList.reduce((n, a) => n + total(a.tokens), 0)

    const limitRow = (l: Limit) => {
      const reset = l.resetsAt
        ? `resets in ${fmtCountdown(Date.parse(l.resetsAt) - at)}`
        : 'no reset time'

      return (
        <Text>
          {limitName(l.kind).padEnd(12)}
          <Text color={pctColor(l.percentUsed)}>{bar(l.percentUsed, barWidth)}</Text>
          {` ${l.percentUsed.toFixed(1).padStart(5)}%  `}
          <Text dimColor>{reset}</Text>
        </Text>
      )
    }

    const agentRow = (a: AgentStat) => {
      const live = isLive(a.status)
      const rate = live ? burnRate(a, at) : 0
      const hot = rate > threshold
      const name = a.description || a.id
      const rateColor = hot ? 'red' : rate > threshold / 2 ? 'yellow' : 'green'

      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold={live} dimColor={!live}>
              {live ? '● ' : '○ '}
              {name}
              {a.type ? <Text dimColor>{` (${a.type})`}</Text> : null}
              {`  ${a.killRequested && live ? 'stopping…' : a.status}`}
            </Text>
          </Box>
          <Box>
            <Text dimColor={!live}>
              {'   burn '}
              <Text color={live ? rateColor : undefined}>{`${fmtTokens(rate)}/min`}</Text>
              {`  total ${fmtTokens(total(a.tokens))}`}
              <Text dimColor>{`  (cache read ${fmtTokens(a.tokens.cacheRead)})  `}</Text>
            </Text>
            {live && !a.killRequested ? (
              <Button
                key={`kill-${a.id}`}
                label="Kill"
                variant={hot ? 'primary' : 'secondary'}
                onPress={() => kill($, a.id, 'killed from Token Dash')}
              />
            ) : null}
          </Box>
          {live ? <Text dimColor>{`   ↳ ${a.activity}`}</Text> : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>Usage</Text>
        <Text>
          {'Context     '}
          {u.contextPercent !== undefined ? (
            <Text color={pctColor(u.contextPercent)}>{`${u.contextPercent}%`}</Text>
          ) : (
            <Text dimColor>-</Text>
          )}
          {` (${fmtTokens(u.contextTokens ?? 0)} / ${fmtTokens(u.contextWindow)})`}
          {u.costUsd !== undefined ? `   cost $${u.costUsd.toFixed(2)}` : ''}
        </Text>
        <Text>
          {'Main        '}
          {`in ${fmtTokens(u.main.input)}  out ${fmtTokens(u.main.output)}  cache w ${fmtTokens(u.main.cacheWrite)} r ${fmtTokens(u.main.cacheRead)}`}
        </Text>
        <Text>
          {'Subagents   '}
          {`${fmtTokens(agentTotal)} tokens`}
        </Text>
        {u.limits.length === 0 ? (
          <Text dimColor>No rate-limit reading yet (shows after the first reply on a subscription).</Text>
        ) : (
          u.limits.map(limitRow)
        )}

        <Box marginTop={1}>
          <Text bold>{`Subagents (${agentList.filter(a => isLive(a.status)).length} running)`}</Text>
        </Box>
        <Box>
          <Text>{`Burn limit ${fmtTokens(threshold)}/min `}</Text>
          <Button
            key="threshold-down"
            label="-"
            onPress={() =>
              saveSettings($, s => ({ ...s, threshold: Math.max(STEP, s.threshold - STEP) }))
            }
          />
          <Button
            key="threshold-up"
            label="+"
            onPress={() => saveSettings($, s => ({ ...s, threshold: s.threshold + STEP }))}
          />
          <Text>{'  '}</Text>
          <Button
            key="auto-kill"
            label={autoKill ? 'Auto-kill: ON' : 'Auto-kill: off'}
            variant={autoKill ? 'primary' : 'secondary'}
            onPress={() => saveSettings($, s => ({ ...s, autoKill: !s.autoKill }))}
          />
        </Box>
        {agentList.length === 0 ? <Text dimColor>No subagents yet.</Text> : agentList.map(agentRow)}
      </Box>
    )
  })
}
