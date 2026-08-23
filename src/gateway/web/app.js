import * as GatewayTokenUtils from './token-utils.js'

const $ = (id) => document.getElementById(id)

const elements = {
  connectionPill: $('connection-pill'),
  connectionLabel: $('connection-label'),
  endpointValue: $('endpoint-value'),
  refreshButton: $('refresh-button'),
  tokenButton: $('token-button'),
  copyEndpoint: $('copy-endpoint'),
  autoRefresh: $('auto-refresh'),
  searchInput: $('search-input'),
  statusFilter: $('status-filter'),
  requestRows: $('request-rows'),
  requestEmpty: $('request-empty'),
  requestCount: $('request-count'),
  clearDiagnostics: $('clear-diagnostics'),
  detailPanel: $('detail-panel'),
  anchorList: $('anchor-list'),
  anchorJobs: $('anchor-jobs'),
  anchorForm: $('anchor-form'),
  anchorProfile: $('anchor-profile'),
  anchorPrompt: $('anchor-prompt'),
  anchorContinuation: $('anchor-continuation'),
  anchorReasoningEffort: $('anchor-reasoning-effort'),
  anchorRuns: $('anchor-runs'),
  anchorSubturns: $('anchor-subturns'),
  anchorMaxTokens: $('anchor-max-tokens'),
  anchorCostNote: $('anchor-cost-note'),
  profileList: $('profile-list'),
  deploymentForm: $('deployment-form'),
  deploymentMode: $('deployment-mode'),
  deploymentCombinedPort: $('deployment-combined-port'),
  deploymentNote: $('deployment-note'),
  configList: $('config-list'),
  lastUpdated: $('last-updated'),
  tokenDialog: $('token-dialog'),
  tokenInput: $('token-input'),
  clearToken: $('clear-token'),
  saveToken: $('save-token'),
  candidateDialog: $('candidate-dialog'),
  candidateDialogTitle: $('candidate-dialog-title'),
  candidateDialogBody: $('candidate-dialog-body'),
  candidateDialogClose: $('candidate-dialog-close'),
  liveDialog: $('live-dialog'),
  liveDialogTitle: $('live-dialog-title'),
  liveDialogBody: $('live-dialog-body'),
  liveDialogClose: $('live-dialog-close'),
  messagesDialog: $('messages-dialog'),
  messagesDialogTitle: $('messages-dialog-title'),
  messagesDialogBody: $('messages-dialog-body'),
  messagesDialogClose: $('messages-dialog-close'),
  anchorDialog: $('anchor-dialog'),
  anchorDialogTitle: $('anchor-dialog-title'),
  anchorDialogBody: $('anchor-dialog-body'),
  anchorDialogClose: $('anchor-dialog-close'),
  toast: $('toast'),
}

const state = {
  health: null,
  entries: [],
  markerProfile: null,
  config: null,
  anchorCatalog: [],
  jobs: [],
  retained: 0,
  selectedId: null,
  liveJobId: null,
  loading: false,
  token: sessionStorage.getItem('gateway-management-token') ?? '',
}

let toastTimer
let loadEpoch = 0

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return '—'
  return new Intl.NumberFormat('zh-CN').format(Number(value))
}

function formatCompact(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  if (number < 1000) return String(Math.round(number))
  if (number < 1_000_000) return `${(number / 1000).toFixed(number < 10_000 ? 1 : 0)}k`
  return `${(number / 1_000_000).toFixed(number < 10_000_000 ? 1 : 0)}M`
}

function formatTime(value, includeDate = false) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', includeDate
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
}

function formatDuration(value) {
  if (!Number.isFinite(Number(value))) return '—'
  const milliseconds = Number(value)
  if (milliseconds < 1000) return `${milliseconds} ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return '—'
  const percent = Number(value) * 100
  return `${percent.toFixed(percent >= 99.95 || percent === 0 ? 0 : 1)}%`
}

function cacheUsage(summary) {
  if (summary?.cache && Number.isFinite(Number(summary.cache.hitTokens))) {
    return summary.cache
  }
  const tokens = GatewayTokenUtils.tokensFromSummary(summary)
  if (tokens && tokens.cacheInput != null) {
    const hit = Number(tokens.cacheInput)
    const miss = tokens.uncachedInput != null ? Number(tokens.uncachedInput) : null
    const totalTokens = miss != null ? hit + miss : null
    return {
      hitTokens: hit,
      missTokens: miss,
      totalTokens,
      hitRate: tokens.hitRate ?? null,
    }
  }
  const usage = summary?.usage
  if (!usage || typeof usage !== 'object') return null
  const numeric = (...values) => {
    for (const value of values) {
      if (value === undefined || value === null || value === '') continue
      const number = Number(value)
      if (Number.isFinite(number) && number >= 0) return number
    }
    return null
  }
  let hitTokens = numeric(
    usage.prompt_cache_hit_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.cache_read_input_tokens,
  )
  let missTokens = numeric(usage.prompt_cache_miss_tokens)
  const promptTokens = numeric(usage.prompt_tokens, usage.input_tokens)
  if (hitTokens === null && missTokens === null) return null
  if (hitTokens === null && promptTokens !== null) hitTokens = Math.max(0, promptTokens - missTokens)
  if (missTokens === null && promptTokens !== null) missTokens = Math.max(0, promptTokens - hitTokens)
  hitTokens ??= 0
  missTokens ??= 0
  const totalTokens = hitTokens + missTokens
  return { hitTokens, missTokens, totalTokens, hitRate: totalTokens ? hitTokens / totalTokens : null }
}

function aggregateCache(entries) {
  let hitTokens = 0
  let missTokens = 0
  let requests = 0
  for (const entry of entries) {
    const cache = cacheUsage(entry.response?.summary)
    if (!cache || !Number.isFinite(Number(cache.hitRate))) continue
    hitTokens += Number(cache.hitTokens ?? 0)
    missTokens += Number(cache.missTokens ?? 0)
    requests += 1
  }
  const totalTokens = hitTokens + missTokens
  return { hitTokens, missTokens, totalTokens, requests, hitRate: totalTokens ? hitTokens / totalTokens : null }
}

const trajectoryLabels = {
  'gray-test': '灰度测试思维链',
  minimal: 'Minimal 思维链',
  'let-me': 'let me 思维链',
  mixed: '无明显倾向',
}

function trajectoryLabel(value) {
  return trajectoryLabels[value] ?? value ?? '未分类'
}

const COT_POLARITY_TITLES = {
  'strong-positive': '灰度测试思维链特征',
  positive: '正式版强思维链（Minimal）',
  negative: '正式版弱思维链（let me）',
}

function openingPreview(reasoning) {
  if (!reasoning) return '—'
  if (reasoning.openingPreview) return reasoning.openingPreview
  if (reasoning.chars === 0) return '无推理文本'
  return '历史记录未保存片段'
}

function shortId(value, length = 10) {
  const text = String(value ?? '')
  return text.length > length ? `${text.slice(0, length)}…` : text || '—'
}

function toast(message) {
  clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.classList.add('visible')
  toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 2200)
}

async function copyText(value, message = '已复制') {
  try {
    await navigator.clipboard.writeText(value)
    toast(message)
  } catch {
    toast('浏览器没有授予剪贴板权限')
  }
}

function setConnection(status, label) {
  elements.connectionPill.className = `status-pill ${status}`
  elements.connectionLabel.textContent = label
}

async function fetchJson(path, options = {}) {
  const headers = { accept: 'application/json' }
  if (state.token) headers['x-gateway-management-token'] = state.token
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    headers['x-gateway-management-request'] = '1'
  }
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  })
  if (!response.ok) {
    let message = `Gateway returned HTTP ${response.status}`
    try {
      const payload = await response.json()
      message = payload?.error?.message ?? message
    } catch {
      // Keep the transport-level message.
    }
    const error = new Error(message)
    error.status = response.status
    throw error
  }
  return response.json()
}

async function fetchOptionalJson(path, fallback) {
  try {
    return await fetchJson(path)
  } catch (error) {
    if (error.status === 404 || error.status === 501) return fallback
    throw error
  }
}

function requestState(entry) {
  const response = entry?.response
  if (!response || response.error || response.transportError || Number(response.status) >= 400) return 'error'
  if (response.abortedByClient || response.summary?.complete === false) return 'interrupted'
  if (response.summary?.complete === true) return 'complete'
  return 'interrupted'
}

const stateLabels = {
  complete: '完整结束',
  interrupted: '中断',
  error: '错误',
}

function currentToolNames(entry) {
  return entry?.response?.summary?.tools?.names ?? entry?.response?.summary?.toolNames ?? []
}

function gatewayInstances() {
  if (Array.isArray(state.health?.instances) && state.health.instances.length) {
    return state.health.instances
  }
  if (!state.health) return []
  return [{
    ...state.health,
    profile: state.health.profile ?? 'single',
    baseUrl: `${location.origin}/v1`,
  }]
}

function endpointCopyValue() {
  return gatewayInstances()
    .map((instance) => `${instance.profile}: ${instance.baseUrl}`)
    .join('\n')
}

function renderTools(names) {
  if (!Array.isArray(names) || names.length === 0) return '<span class="muted">无</span>'
  return `<div class="tool-sequence">${names.map((name, index) => `${index ? '<span class="tool-arrow">→</span>' : ''}<span class="tool-chip">${escapeHtml(name)}</span>`).join('')}</div>`
}

function filteredEntries() {
  const query = elements.searchInput.value.trim().toLowerCase()
  const filter = elements.statusFilter.value
  return state.entries.filter((entry) => {
    const status = requestState(entry)
    if (filter !== 'all' && status !== filter) return false
    if (!query) return true
    const searchable = [
      entry.requestId,
      entry.request?.model,
      entry.mode,
      ...currentToolNames(entry),
    ].filter(Boolean).join(' ').toLowerCase()
    return searchable.includes(query)
  })
}

function renderMetrics() {
  const health = state.health
  const instances = gatewayInstances()
  const complete = state.entries.filter((entry) => requestState(entry) === 'complete').length
  const reasoningChars = state.entries.reduce(
    (sum, entry) => sum + Number(entry.response?.summary?.reasoning?.chars ?? 0),
    0,
  )
  const toolCalls = state.entries.reduce(
    (sum, entry) => sum + Number(entry.response?.summary?.tools?.callCount ?? 0),
    0,
  )
  const letMe = state.entries.reduce(
    (sum, entry) => sum + Number(entry.response?.summary?.reasoning?.markers?.letMe ?? 0)
      + Number(entry.response?.summary?.reasoning?.markers?.letMeZh ?? 0),
    0,
  )
  const totalCache = aggregateCache(state.entries)
  $('metric-mode').textContent = ['split', 'all'].includes(health?.deploymentMode) ? '父子进程' : health?.mode ?? '—'
  $('metric-mode-note').textContent = health
    ? !health.gatewayApiKeyConfigured
      ? '数据面等待 Gateway Key'
      : ['split', 'all'].includes(health.deploymentMode)
        ? `1 个管理父进程 + ${instances.length} 个模型子进程 · ${health.gatewayApiKeyConfiguredCount ?? instances.length}/${instances.length} 已配置 Key`
        : health.mode === 'anchor' ? 'Chat Completions 默认增强' : '默认透明旁路'
    : '等待 Gateway'
  $('metric-anchors').textContent = health ? formatNumber(health.anchors?.length ?? 0) : '—'
  $('metric-anchor-note').textContent = health?.anchors?.length
    ? health.anchors.map((anchor) => anchor.model).join(' · ')
    : '模型严格隔离'
  $('metric-retained').textContent = state.health ? formatNumber(state.retained) : '—'
  $('metric-retained-note').textContent = health
    ? `含重启恢复，上限 ${formatNumber(health.diagnosticHistoryLimit)}`
    : '从轮转日志恢复的诊断记录'
  $('metric-complete').textContent = state.entries.length
    ? `${Math.round((complete / state.entries.length) * 100)}%`
    : '—'
  $('metric-complete-note').textContent = state.entries.length
    ? `${complete} / ${state.entries.length} 次完整结束`
    : '当前可见请求'
  $('metric-reasoning').textContent = state.entries.length ? formatNumber(reasoningChars) : '—'
  $('metric-reasoning-note').textContent = state.entries.length
    ? `平均 ${formatNumber(Math.round(reasoningChars / state.entries.length))} 字符 / 请求`
    : '仅当前回复，不含 Anchor'
  $('metric-tools').textContent = state.entries.length ? `${toolCalls} / ${letMe}` : '—'
  $('metric-tools-note').textContent = state.entries.length
    ? `工具 ${toolCalls} 次 · Let me ${letMe} 次`
    : '当前可见回复汇总'
  $('metric-cache').textContent = formatPercent(totalCache.hitRate)
  $('metric-cache-note').textContent = totalCache.requests
    ? `${formatNumber(totalCache.hitTokens)} / ${formatNumber(totalCache.totalTokens)} tokens · ${totalCache.requests} 条有缓存数据`
    : '上游尚未返回缓存 token 数据'
}

const STREAM_LIMIT = 16

function renderRows() {
  const entries = filteredEntries().slice(0, STREAM_LIMIT)
  elements.requestRows.innerHTML = entries.map((entry) => {
    const status = requestState(entry)
    const summary = entry.response?.summary
    const tools = currentToolNames(entry)
    const tokens = GatewayTokenUtils.tokensFromSummary(summary)
    const reasoningChars = Number(summary?.reasoning?.chars ?? 0)
    const contentChars = Number(summary?.content?.chars ?? 0)
    const toolCount = Number(summary?.tools?.callCount ?? summary?.toolCallCount ?? 0)
    const inputValue = tokens?.input != null ? formatCompact(tokens.input) : '未返回'
    const outputValue = tokens?.output != null ? formatCompact(tokens.output) : '未返回'
    const reasoningValue = tokens?.reasoning != null
      ? formatCompact(tokens.reasoning)
      : `${formatCompact(reasoningChars)} 字符`
    const contentValue = tokens?.content != null
      ? formatCompact(tokens.content)
      : `${formatCompact(contentChars)} 字符`
    // 推理/正文没有 token 分项时回退字符；输入/输出没有 usage 时绝不冒充。
    const cot = summary?.reasoning?.cot
    const cotBadge = reasoningChars > 0 && cot?.label ? trajectoryBadge(cot) : ''
    const modeClass = String(entry.mode ?? '').startsWith('anchor') ? 'anchor' : ''
    return `
      <div data-request-id="${escapeHtml(entry.requestId)}" tabindex="0" role="listitem" class="request-row ${entry.requestId === state.selectedId ? 'selected' : ''}" aria-label="查看请求 ${escapeHtml(entry.requestId)}">
        <div class="row-line row-primary">
          <span class="row-time">${escapeHtml(formatTime(entry.startedAt))}</span>
          ${cotBadge}
          <span class="status-label ${status}">${stateLabels[status]}</span>
          <span class="mode-label ${modeClass}">${escapeHtml(entry.mode ?? '—')}</span>
          <span class="row-model">${escapeHtml(entry.request?.model ?? shortId(entry.requestId))}${entry.profile ? ` · ${escapeHtml(entry.profile)}` : ''}</span>
          <span class="row-duration">${escapeHtml(formatDuration(entry.durationMs))}</span>
        </div>
        <div class="row-line row-secondary">
          <span class="io-flow">
            <b title="${tokens?.input != null ? `上游提示 ${formatNumber(tokens.input)} tokens` : '上游未返回 usage'}">输入 ${inputValue}${tokens?.input != null ? ' tokens' : ''}</b>
            <span class="io-arrow" aria-hidden="true">→</span>
            <b title="${tokens?.output != null ? `上游输出 ${formatNumber(tokens.output)} tokens（推理 ${tokens.reasoning != null ? formatNumber(tokens.reasoning) : '未返回'} · 正文 ${tokens.content != null ? formatNumber(tokens.content) : '未返回'}）` : '上游未返回 usage'}">输出 ${outputValue}${tokens?.output != null ? ' tokens' : ''}</b>
          </span>
          <span class="io-detail">缓存输入 ${tokens?.cacheInput != null ? `${formatCompact(tokens.cacheInput)} tokens` : '—'} · 命中 ${formatPercent(tokens?.hitRate)} · 推理 ${reasoningValue}${tokens?.reasoning != null ? ' tokens' : ''} · 正文 ${contentValue}${tokens?.content != null ? ' tokens' : ''} · 工具 ${formatNumber(toolCount)} 次</span>
          ${tools.length ? renderTools(tools) : ''}
        </div>
      </div>`
  }).join('')

  elements.requestEmpty.hidden = entries.length > 0
  elements.requestCount.textContent = state.entries.length
    ? `显示 ${entries.length} 条，共保留 ${state.entries.length} 条 · 详情可查看本次新增输入与新回复`
    : '暂无已保存诊断记录；完成或中断的请求会写入轮转日志'
}

function markerLabel(id) {
  return state.markerProfile?.markers?.find((marker) => marker.id === id)?.label ?? id
}

function renderMarkers(markers) {
  if (!markers) return '<p class="muted">没有思维链关键字统计</p>'
  const meta = (id) => state.markerProfile?.markers?.find((marker) => marker.id === id) ?? null
  const profileIds = state.markerProfile?.markers?.map((marker) => marker.id) ?? []
  const ids = [...new Set([...profileIds, ...Object.keys(markers)])]
  const indexOf = (id) => profileIds.indexOf(id)
  ids.sort((left, right) => {
    const a = indexOf(left)
    const b = indexOf(right)
    if (a === -1 && b === -1) return Number(markers[right] ?? 0) - Number(markers[left] ?? 0)
    if (a === -1) return 1
    if (b === -1) return -1
    return a - b
  })
  return `<div class="marker-grid">${ids.map((id) => {
    const count = Number(markers[id] ?? 0)
    const polarity = meta(id)?.polarity ?? 'diagnostic'
    const title = COT_POLARITY_TITLES[polarity] ?? '仅诊断'
    return `<span class="marker-chip ${polarity} ${count ? 'hit' : 'zero'}" title="${title}">${escapeHtml(markerLabel(id))}<b>${formatNumber(count)}</b></span>`
  }).join('')}</div>`
}

function trajectoryBadge(cot) {
  if (!cot?.label) return '<span class="cot-label mixed">未分类</span>'
  const { progressive = 0, collective = 0, interruptive = 0 } = cot.counts ?? {}
  return `<span class="cot-label ${escapeHtml(cot.label)}" title="I'm …ing/我正在 ×${progressive} · we need/我们需要/let's/让我们 ×${collective} · let me/让我 ×${interruptive}">${escapeHtml(trajectoryLabel(cot.label))}</span>`
}

function summaryBlock(title, scope, summary, note = '') {
  if (!summary) {
    return `<section class="detail-block"><div class="detail-block-heading"><h3>${escapeHtml(title)}</h3><span class="scope-badge">${escapeHtml(scope)}</span></div><p class="muted">${escapeHtml(note || '没有可用统计')}</p></section>`
  }
  const reasoning = summary.reasoning ?? {}
  const content = summary.content ?? {}
  const cache = cacheUsage(summary)
  const tokens = GatewayTokenUtils.tokensFromSummary(summary)
  const hasReasoningTokens = tokens?.reasoning != null
  const hasContentTokens = tokens?.content != null
  const reasoningValue = hasReasoningTokens
    ? formatNumber(tokens.reasoning)
    : formatNumber(reasoning.chars ?? summary.reasoningChars)
  const contentValue = hasContentTokens
    ? formatNumber(tokens.content)
    : formatNumber(content.chars ?? summary.contentChars)
  return `
    <section class="detail-block">
      <div class="detail-block-heading">
        <h3>${escapeHtml(title)}</h3>
        <span class="scope-badge">${escapeHtml(scope)}</span>
      </div>
      ${note ? `<p class="muted">${escapeHtml(note)}</p>` : ''}
      <div class="mini-metrics">
        <div class="mini-metric"><span>${hasReasoningTokens ? '推理 tokens' : '推理字符'}</span><strong>${reasoningValue}</strong></div>
        <div class="mini-metric"><span>${hasContentTokens ? '正文 tokens' : '正文字符'}</span><strong>${contentValue}</strong></div>
        <div class="mini-metric"><span>推理块</span><strong>${formatNumber(reasoning.nonEmptyBlocks ?? reasoning.blocks)}</strong></div>
        <div class="mini-metric wide"><span title="英文保留前四个词，中文保留前四个字">开头四词 / 四字</span><strong>${escapeHtml(openingPreview(reasoning))}</strong></div>
        <div class="mini-metric"><span>思维链</span><strong>${escapeHtml(trajectoryLabel(reasoning.cot?.label))}</strong></div>
        ${cache ? `<div class="mini-metric"><span>缓存命中率</span><strong>${formatPercent(cache.hitRate)}</strong></div>` : ''}
      </div>
      <p class="subheading">思维链关键字</p>
      ${renderMarkers(reasoning.markers)}
      <p class="subheading">工具调用序列</p>
      ${renderTools(summary.tools?.names ?? summary.toolNames ?? [])}
    </section>`
}

function basicInfoFacts(entry, summary) {
  const cache = cacheUsage(summary)
  const tokens = GatewayTokenUtils.tokensFromSummary(summary)
  const toolCalls = Number(summary?.tools?.callCount ?? summary?.toolCallCount ?? 0)
  const reasoningChars = Number(summary?.reasoning?.chars ?? 0)
  const contentChars = Number(summary?.content?.chars ?? 0)
  const inputValue = tokens?.input != null
    ? `${formatNumber(tokens.input)} tokens`
    : '未返回'
  const outputValue = tokens?.output != null
    ? `${formatNumber(tokens.output)} tokens`
    : '未返回'
  const reasoningValue = tokens?.reasoning != null
    ? `${formatNumber(tokens.reasoning)} tokens`
    : `${formatCompact(reasoningChars)} 字符`
  const contentValue = tokens?.content != null
    ? `${formatNumber(tokens.content)} tokens`
    : `${formatCompact(contentChars)} 字符`
  const cacheInput = tokens?.cacheInput ?? cache?.hitTokens
  const uncachedInput = tokens?.uncachedInput ?? cache?.missTokens
  const hitRate = tokens?.hitRate ?? cache?.hitRate
  return `
    <div class="basic-stat"><span>输入</span><b>${inputValue}</b></div>
    <div class="basic-stat"><span>输出</span><b>${outputValue}</b></div>
    <div class="basic-stat"><span>缓存输入</span><b>${cacheInput != null ? formatNumber(cacheInput) : '—'}</b></div>
    <div class="basic-stat"><span>未缓存输入</span><b>${uncachedInput != null ? formatNumber(uncachedInput) : '—'}</b></div>
    <div class="basic-stat"><span>命中率</span><b>${formatPercent(hitRate)}</b></div>
    <div class="basic-stat"><span>推理</span><b>${reasoningValue}</b></div>
    <div class="basic-stat"><span>正文</span><b>${contentValue}</b></div>
    <div class="basic-stat"><span>工具次数</span><b>${formatNumber(toolCalls)}</b></div>`
}

function responseReason(entry, summary) {
  const response = entry.response
  if (response?.transportError) return `传输中断：${escapeHtml(response.transportError)}`
  if (response?.error) return `错误：${escapeHtml(response.error)}`
  if (response?.abortedByClient) return '客户端中断连接'
  if (summary?.finishReasons?.length) {
    return `结束原因：${summary.finishReasons.map(escapeHtml).join(', ')}`
  }
  return '—'
}

function renderDetail() {
  const entry = state.entries.find((item) => item.requestId === state.selectedId)
  if (!entry) {
    elements.detailPanel.innerHTML = `
      <div class="detail-placeholder">
        <span aria-hidden="true">↳</span>
        <h2>选择一次请求</h2>
        <p>这里拆开显示基础信息、推理（锚点外）与 Anchor 的思维链统计，并可查看本轮完整消息。</p>
      </div>`
    return
  }

  const status = requestState(entry)
  const responseSummary = entry.response?.summary
  const anchorHistory = entry.transformation?.anchorHistory
  const cache = cacheUsage(responseSummary)
  const hasMessages = Array.isArray(entry.messages?.request) || Array.isArray(entry.messages?.response)

  elements.detailPanel.innerHTML = `
    <div class="detail-header">
      <div class="detail-title-row">
        <div>
          <p class="section-kicker">请求详情</p>
          <h2>${escapeHtml(entry.request?.model ?? '未知模型')}</h2>
        </div>
        ${trajectoryBadge(responseSummary?.reasoning?.cot)}
      </div>
      <button class="request-id-button" type="button" data-copy-id="${escapeHtml(entry.requestId)}" title="复制完整请求 ID">
        <span>请求</span><code>${escapeHtml(entry.requestId)}</code><b>复制</b>
      </button>
      <div class="detail-statuses">
        <span class="status-label ${status}">${stateLabels[status]}</span>
        ${entry.profile ? `<span class="mode-label">${escapeHtml(entry.profile)}</span>` : ''}
        <span class="mode-label ${String(entry.mode ?? '').startsWith('anchor') ? 'anchor' : ''}">${escapeHtml(entry.mode ?? '—')}</span>
        <span class="mode-label">${escapeHtml(formatDuration(entry.durationMs))}</span>
        ${cache ? `<span class="mode-label cache">缓存 ${formatPercent(cache.hitRate)}</span>` : ''}
      </div>
    </div>

    <section class="detail-block">
      <div class="detail-block-heading"><h3>基础信息</h3><span class="scope-badge">usage</span></div>
      <div class="basic-stats">${basicInfoFacts(entry, responseSummary)}</div>
    </section>

    ${summaryBlock('锚点外推理（本次回复）', '本次回复', responseSummary, `只统计这一次上游新生成的内容 · 开头「${escapeHtml(openingPreview(responseSummary?.reasoning))}」`)}
    ${summaryBlock('锚点（Anchor 历史）', '锚点历史', anchorHistory, entry.transformation
      ? `Anchor ${entry.transformation.anchorId ?? '—'} · 注入 ${formatNumber(entry.transformation.anchorMessageChars)} 字符`
      : '本次请求没有注入 Anchor。')}

    <section class="detail-block">
      <div class="detail-block-heading"><h3>状态</h3><span class="scope-badge">status</span></div>
      <dl class="fact-list">
        <div><dt>状态</dt><dd>${stateLabels[status]}</dd></div>
        <div><dt>原因</dt><dd>${responseReason(entry, responseSummary)}</dd></div>
        <div><dt>开始时间</dt><dd>${escapeHtml(formatTime(entry.startedAt, true))}</dd></div>
        <div><dt>HTTP 状态</dt><dd>${escapeHtml(entry.response?.status ?? '—')}</dd></div>
        <div><dt>凭据来源</dt><dd>${escapeHtml(entry.request?.credentialSource ?? '—')}</dd></div>
      </dl>
      ${hasMessages
        ? `<div class="detail-action"><button class="button secondary" type="button" data-view-messages="${escapeHtml(entry.requestId)}">查看本次消息</button></div>`
        : '<p class="muted">没有可查看的原始消息（请求或回复原文未保存）。</p>'}
    </section>`
}

function loadBindings() {
  return Array.isArray(state.health?.anchors) ? state.health.anchors : []
}

function catalogPath(value) {
  return String(value ?? '').replaceAll('\\', '/')
}

function bindingMatchesArtifact(bound, artifact) {
  const boundPath = catalogPath(bound.path)
  const artifactPath = catalogPath(artifact.path)
  return Boolean(
    bound?.fingerprint && artifact?.fingerprint && bound.fingerprint === artifact.fingerprint,
  ) || Boolean(
    artifactPath && boundPath &&
    (boundPath === artifactPath || boundPath.endsWith(`/${artifactPath}`) || artifactPath.endsWith(`/${boundPath}`)),
  )
}

function anchorIsBound(artifact) {
  return loadBindings().some((bound) => bindingMatchesArtifact(bound, artifact))
}

function renderAnchors() {
  const catalog = state.anchorCatalog
  const bindings = loadBindings()
  if (!catalog.length) {
    elements.anchorList.innerHTML = bindings.length
      ? bindings.map((anchor) => `
      <div class="anchor-card bound">
        <div>
          <strong>${escapeHtml(anchor.model ?? '未知模型')}</strong>
          <small>${escapeHtml(anchor.id ?? '未命名')}</small>
          <span class="anchor-badges"><span class="anchor-badge bound">当前绑定</span></span>
        </div>
        <div>
          <code title="${escapeHtml(anchor.fingerprint ?? '')}">SHA-256 ${escapeHtml(shortId(anchor.fingerprint, 20))}</code>
          <code title="${escapeHtml(anchor.path ?? '')}">${escapeHtml(anchor.path ?? '路径不可用')}</code>
        </div>
        <div class="anchor-card-actions"><span class="muted">仅 split 部署可查看</span></div>
      </div>`).join('')
      : '<p class="muted">当前没有可展示的 Anchor；请用 split 部署启动管理节点，这里会显示内置默认与用户已生成的 Artifact。</p>'
    return
  }
  const cards = catalog.map((artifact) => {
    const bound = anchorIsBound(artifact)
    return `
    <div class="anchor-card ${bound ? 'bound' : ''}">
      <div>
        <strong>${escapeHtml(artifact.model ?? '未知模型')}</strong>
        <small>${escapeHtml(artifact.id ?? '未命名')}</small>
        <span class="anchor-badges">
          ${artifact.bundledDefault
            ? '<span class="anchor-badge default">内置默认</span>'
            : '<span class="anchor-badge generated">已生成</span>'}
          ${bound ? '<span class="anchor-badge bound">当前绑定</span>' : ''}
        </span>
      </div>
      <div>
        <code title="${escapeHtml(artifact.fingerprint ?? '')}">SHA-256 ${escapeHtml(shortId(artifact.fingerprint, 20))}</code>
        <code title="${escapeHtml(artifact.path ?? '')}">${escapeHtml(artifact.path ?? '路径不可用')}</code>
      </div>
      <div class="anchor-card-actions">
        <button class="button ghost" type="button" data-view-anchor-path="${escapeHtml(artifact.path ?? '')}" data-view-anchor-id="${escapeHtml(artifact.id ?? '')}">只读查看</button>
      </div>
    </div>`
  }).join('')
  const unmatchedCards = bindings
    .filter((bound) => !catalog.some((artifact) => bindingMatchesArtifact(bound, artifact)))
    .map((anchor) => `
    <div class="anchor-card bound">
      <div>
        <strong>${escapeHtml(anchor.model ?? '未知模型')}</strong>
        <small>${escapeHtml(anchor.id ?? '未命名')}</small>
        <span class="anchor-badges"><span class="anchor-badge bound">当前绑定</span><span class="anchor-badge orphan">目录中未发现</span></span>
      </div>
      <div>
        <code title="${escapeHtml(anchor.fingerprint ?? '')}">SHA-256 ${escapeHtml(shortId(anchor.fingerprint, 20))}</code>
        <code title="${escapeHtml(anchor.path ?? '')}">${escapeHtml(anchor.path ?? '路径不可用')}</code>
      </div>
      <div class="anchor-card-actions"><span class="muted">文件不在 anchors/ 目录或已损坏</span></div>
    </div>`).join('')
  elements.anchorList.innerHTML = `${cards}${unmatchedCards}`
}

function renderProfiles() {
  const profiles = state.config?.profiles ?? state.health?.managedProfiles ?? []
  if (!profiles.length) {
    elements.profileList.innerHTML = '<p class="muted">当前服务不是可管理的 split 模式。请用一键脚本启动默认的管理/数据分离部署。</p>'
    return
  }
  elements.profileList.innerHTML = profiles.map((profile) => {
    const keyPreview = profile.apiKeyPreview
      ? `<small class="key-preview">当前保存：<code>${escapeHtml(profile.apiKeyPreview)}</code></small>`
      : '<small class="key-preview empty">当前未保存 Key</small>'
    const availableAnchors = state.anchorCatalog.filter((anchor) => anchor.model === profile.model)
    if (profile.anchorPath && !availableAnchors.some((anchor) => anchor.path === profile.anchorPath)) {
      availableAnchors.unshift({ id: '当前配置（目录中未发现）', path: profile.anchorPath })
    }
    const anchorOptions = [
      `<option value="" ${profile.anchorPath ? '' : 'selected'}>未绑定 Anchor（bypass 可用）</option>`,
      ...availableAnchors.map((anchor) => `<option value="${escapeHtml(anchor.path)}" ${anchor.path === profile.anchorPath ? 'selected' : ''}>${escapeHtml(anchor.id)}${anchor.bundledDefault ? ' · 内置只读' : ' · 已冻结'}</option>`),
    ].join('')
    return `
    <article class="profile-card">
      <div class="profile-title">
        <div><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(profile.model)}</small></div>
        <span class="profile-state ${profile.running ? 'running' : ''}">${profile.running ? '运行中' : '已停止'}</span>
      </div>
      <form class="profile-form" data-profile="${escapeHtml(profile.name)}">
        <div class="profile-form-fields">
          <label class="toggle-field wide"><input name="enabled" type="checkbox" ${profile.enabled ? 'checked' : ''}><span>启用 ${escapeHtml(profile.name.toUpperCase())} 数据面</span></label>
          <label><span>数据端口</span><input name="port" type="number" min="1" max="65535" value="${escapeHtml(profile.port)}" required></label>
          <label><span>增强模式</span><select name="enhancementMode"><option value="anchor" ${profile.enhancementMode === 'anchor' ? 'selected' : ''}>anchor</option><option value="bypass" ${profile.enhancementMode === 'bypass' ? 'selected' : ''}>bypass</option></select></label>
          <label class="wide"><span>上游 Base URL</span><input name="upstreamBaseUrl" type="url" value="${escapeHtml(profile.upstreamBaseUrl)}" required spellcheck="false"></label>
          <label class="wide"><span>Gateway API Key</span><input name="apiKey" type="password" value="" placeholder="${profile.apiKeyConfigured ? profile.apiKeySource === 'shared-fallback' ? '当前继承共享 Key；输入后改为独立 Key' : '输入新 Key 可替换；留空保持不变' : '尚未配置'}" autocomplete="new-password" spellcheck="false">${keyPreview}</label>
          <label class="wide"><span>模型专属 Anchor</span><select name="anchorPath">${anchorOptions}</select></label>
          <label class="toggle-field wide"><input name="clearApiKey" type="checkbox"><span>保存时清除现有 Key</span></label>
        </div>
        <p class="form-note">Key 只写入本机 <code>gateway.config.json</code>，页面只读取脱敏预览、绝不回传明文；无模型原生 Anchor 时先用 bypass，生成并绑定后再切换 anchor。</p>
        <button class="button primary" type="submit">保存并热应用 ${escapeHtml(profile.name.toUpperCase())}</button>
      </form>
    </article>`
  }).join('')
}

const deploymentModeLabels = {
  split: '多端口 · 每端口一个模型',
  single: '单数据端口 · 多模型',
  all: '全部开启',
}

function renderDeployment() {
  const deployment = state.config?.deployment ?? {
    mode: state.health?.deploymentMode ?? 'split',
    combinedPort: 8646,
  }
  elements.deploymentMode.value = deployment.mode ?? 'split'
  elements.deploymentCombinedPort.value = deployment.combinedPort ?? 8646
  elements.deploymentNote.textContent = `当前运行：${deploymentModeLabels[state.health?.deploymentMode] ?? state.health?.deploymentMode ?? '未知'}；保存后需重启才切换拓扑。single 与 all 的合并数据面使用共享上游和 Key；8646 只在“全部开启”时使用。`
}

const jobStatusLabels = {
  queued: '排队中',
  running: '生成中',
  'awaiting-selection': '待挑选候选',
  freezing: '正在保存',
  succeeded: '已保存并启用',
  failed: '失败',
  discarded: '已废弃',
}

const stopReasonLabels = {
  'turn-limit': '达到轮数上限',
  'final-answer': '已生成最终答复',
  'open-after-second-tool-result': '第二个工具结果后结束（旧格式）',
}

function renderBuilderToolStatus(candidate) {
  const statuses = [
    ['bash', Boolean(candidate.toolStatus?.bash)],
    ['str_replace_editor', Boolean(candidate.toolStatus?.strReplaceEditor)],
  ]
  return `<div class="builder-tool-status">${statuses.map(([name, called]) => `
    <div class="builder-tool-card ${called ? 'called' : 'missing'}">
      <strong>${escapeHtml(name)}</strong>
      <span>${called ? '已调用' : '未调用'}</span>
    </div>`).join('')}</div>`
}

function renderJobProgress(job) {
  if (!['queued', 'running'].includes(job.status)) return ''
  if (job.status === 'queued') {
    return `
      <div class="job-progress">
        <p class="job-progress-title"><span class="pulse-dot"></span>排队中，尚未发起上游请求</p>
        <p class="muted">正在等待之前任务释放该配置的生成位…</p>
      </div>`
  }
  const live = job.live
  const usage = live?.usage
  const inputTokens = Number(usage?.promptTokens ?? 0)
  const outputTokens = Number(usage?.completionTokens ?? 0)
  const cacheHit = Number(usage?.cacheHitTokens ?? 0)
  const cacheMiss = Number(usage?.cacheMissTokens ?? 0)
  const cacheTotal = cacheHit + cacheMiss
  const cacheRate = cacheTotal ? cacheHit / cacheTotal : null
  const tools = Number(live?.totalToolCalls ?? 0)
  const candidateText = live ? `候选 ${live.candidate} / ${job.runs} · 第 ${live.subturn} 轮` : `候选 / ${job.runs}`
  const reasoningTail = live?.reasoningTail || '正在等待第一个上游响应…'
  return `
    <div class="job-progress">
      <p class="job-progress-title"><span class="pulse-dot"></span>${candidateText} · 已输出推理 ${formatNumber(live?.reasoningChars ?? 0)} 字符</p>
      <div class="job-live-stats">
        <span>输入 <b>${inputTokens ? `${formatCompact(inputTokens)} tokens` : '…'}</b></span>
        <span>输出 <b>${outputTokens ? `${formatCompact(outputTokens)} tokens` : '…'}</b></span>
        <span>缓存命中 <b>${cacheTotal ? formatPercent(cacheRate) : '…'}</b></span>
        <span>工具 <b>${tools}</b> 次</span>
      </div>
      <p class="job-live-line" title="${escapeHtml(reasoningTail)}">${escapeHtml(reasoningTail)}</p>
      <div class="job-progress-actions">
        <button class="button ghost" type="button" data-view-live="${escapeHtml(job.id)}">查看实时输出</button>
      </div>
    </div>`
}

function renderCandidateList(job) {
  if (job.status !== 'awaiting-selection' || !job.candidates?.length) return ''
  return `
    <div class="candidate-list">
      ${job.candidates.map((candidate) => {
        const usage = candidate.usage ?? {}
        const inputTokens = Number(usage.promptTokens ?? 0)
        const outputTokens = Number(usage.completionTokens ?? 0)
        const cacheHit = Number(usage.cacheHitTokens ?? 0)
        const cacheMiss = Number(usage.cacheMissTokens ?? 0)
        const cacheTotal = cacheHit + cacheMiss
        const cacheRate = cacheTotal ? cacheHit / cacheTotal : null
        const reasoningTokens = Number(usage.reasoningTokens ?? 0)
        const contentTokens = outputTokens && reasoningTokens <= outputTokens
          ? outputTokens - reasoningTokens
          : null
        return `
        <div class="candidate-card">
          <div class="candidate-head">
            <div class="candidate-title">
              <strong>候选 ${candidate.candidateIndex}</strong>
              ${trajectoryBadge(candidate.cot)}
            </div>
            <div class="candidate-actions">
              <button class="button ghost" type="button" data-view-candidate="${escapeHtml(job.id)}" data-candidate-index="${candidate.candidateIndex}">查看完整对话</button>
              <button class="button primary candidate-select" type="button" data-select-candidate="${escapeHtml(job.id)}" data-candidate-index="${candidate.candidateIndex}">选用并保存</button>
            </div>
          </div>
          <div class="basic-stats">
            <div class="basic-stat"><span>输入</span><b>${inputTokens ? `${formatNumber(inputTokens)} tokens` : '—'}</b></div>
            <div class="basic-stat"><span>输出</span><b>${outputTokens ? `${formatNumber(outputTokens)} tokens` : '—'}</b></div>
            <div class="basic-stat"><span>缓存输入</span><b>${formatNumber(cacheHit)} tokens</b></div>
            <div class="basic-stat"><span>命中率</span><b>${formatPercent(cacheRate)}</b></div>
            <div class="basic-stat"><span>工具</span><b>${formatNumber(candidate.totalToolCalls)}</b></div>
            <div class="basic-stat"><span>推理</span><b>${reasoningTokens ? `${formatNumber(reasoningTokens)} tokens` : `${formatNumber(candidate.reasoningChars)} 字符`}</b></div>
            <div class="basic-stat"><span>正文</span><b>${contentTokens != null ? `${formatNumber(contentTokens)} tokens` : `${formatNumber(candidate.contentChars)} 字符`}</b></div>
            <div class="basic-stat wide"><span>开头预览</span><b>${escapeHtml(candidate.openingPreview || '—')}</b></div>
          </div>
          ${renderBuilderToolStatus(candidate)}
          <p class="subheading">思维链关键字</p>
          ${renderMarkers(candidate.markers)}
          <p class="candidate-facts-note">生成状态：${escapeHtml(stopReasonLabels[candidate.stopReason] ?? candidate.stopReason ?? '—')}</p>
        </div>`
      }).join('')}
    </div>
    <div class="job-actions">
      <button class="button ghost" type="button" data-discard-job="${escapeHtml(job.id)}">废弃本次生成</button>
    </div>`
}

function renderAnchorJobs() {
  if (!state.jobs.length) {
    elements.anchorJobs.innerHTML = ''
    return
  }
  elements.anchorJobs.innerHTML = state.jobs.slice(0, 5).map((job) => {
    const detail = job.error
      ? job.error
      : job.status === 'awaiting-selection'
        ? `${job.candidates?.length ?? 0} 个候选已生成，请根据自然输出挑选`
        : job.status === 'succeeded'
          ? `${job.runs} 个候选 · 已选用候选 ${job.selectedCandidate ?? '—'} · ${job.artifactPath ? escapeHtml(job.artifactPath) : ''}`
          : `${job.runs} 个候选 · 思考强度 ${escapeHtml(job.reasoningEffort ?? 'max')} · 提示词 ${formatNumber(job.anchorPromptChars)} 字符 · 最多 ${job.maximumUpstreamCalls} 次请求${job.artifactPath ? ` · ${escapeHtml(job.artifactPath)}` : ''}`
    return `
    <div class="job-card ${job.status === 'running' || job.status === 'queued' ? 'running' : ''} ${job.status === 'awaiting-selection' || job.status === 'running' || job.status === 'queued' ? 'expanded' : ''}">
      <div class="job-row">
        <div>
          <strong>${escapeHtml(job.profile.toUpperCase())} · ${escapeHtml(job.anchorId)}</strong>
          <small>${detail}</small>
        </div>
        <span class="job-status ${escapeHtml(job.status)}">${escapeHtml(jobStatusLabels[job.status] ?? job.status)}</span>
      </div>
      ${renderJobProgress(job)}
      ${renderCandidateList(job)}
    </div>`
  }).join('')
}

async function pickJobAction(button, action) {
  const jobId = action === 'select' ? button.dataset.selectCandidate : button.dataset.discardJob
  const job = state.jobs.find((item) => item.id === jobId)
  if (!job) return
  const candidateIndex = Number(button.dataset.candidateIndex)
  if (action === 'select' &&
    !window.confirm(`将把候选 ${candidateIndex} 冻结为 Anchor 并绑定到 ${job.profile.toUpperCase()}，已启用的数据面会立即热应用。继续吗？`)) return
  if (action === 'discard' &&
    !window.confirm('将废弃本次生成的全部候选，结果文件也会一并删除，已产生的上游费用不会退回。确定继续吗？')) return
  button.disabled = true
  try {
    const result = await fetchJson(`/__gateway/anchors/jobs/${encodeURIComponent(jobId)}/${action}`, {
      method: 'POST',
      body: action === 'select' ? { candidate: candidateIndex } : {},
    })
    const index = state.jobs.findIndex((item) => item.id === jobId)
    if (index !== -1) state.jobs[index] = result.job
    renderAnchorJobs()
    renderAnchorControls()
    toast(action === 'select'
      ? '已开始冻结所选候选；完成后自动绑定并热应用'
      : '本次生成已废弃')
    loadData({ quiet: true })
  } catch (error) {
    toast(`操作失败：${error.message}`)
    button.disabled = false
  }
}

function conversationBlock(message, index) {
  const role = message?.role ?? 'unknown'
  const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : ''
  const content = typeof message?.content === 'string' ? message.content
    : Array.isArray(message?.content) ? message.content.map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : JSON.stringify(part)).join('\n') : ''
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  const roleLabels = {
    system: '系统指令',
    developer: '开发者指令',
    user: '用户',
    assistant: '助手',
    tool: '工具结果',
  }
  return `
    <div class="conversation-item ${escapeHtml(role)}">
      <div class="conversation-meta">
        <b>#${index + 1} ${escapeHtml(roleLabels[role] ?? role)}</b>
        ${calls.length ? `<span>${calls.map((call) => `${escapeHtml(call?.function?.name ?? 'tool')}(${escapeHtml(String(call?.function?.arguments ?? '').slice(0, 200))}${String(call?.function?.arguments ?? '').length > 200 ? '…' : ''})`).join(' · ')}</span>` : ''}
      </div>
      ${reasoning ? `<pre class="conversation-reasoning">${escapeHtml(reasoning)}</pre>` : ''}
      ${content ? `<pre class="conversation-content">${escapeHtml(content)}</pre>` : ''}
      ${!reasoning && !content && !calls.length ? '<pre class="conversation-content muted">（空消息）</pre>' : ''}
    </div>`
}

async function openCandidateConversation(jobId, candidateIndex) {
  const job = state.jobs.find((item) => item.id === jobId)
  elements.candidateDialogTitle.textContent = `候选 ${candidateIndex} 完整对话${job ? ` · ${job.profile.toUpperCase()}` : ''}`
  elements.candidateDialogBody.innerHTML = '<p class="muted">正在加载完整对话…</p>'
  elements.candidateDialog.showModal()
  try {
    const result = await fetchJson(`/__gateway/anchors/jobs/${encodeURIComponent(jobId)}/candidates/${encodeURIComponent(candidateIndex)}`)
    const candidate = result.candidate ?? {}
    const messages = Array.isArray(candidate.messages) ? candidate.messages : []
    const turns = Array.isArray(candidate.assistantTurns) ? candidate.assistantTurns : []
    elements.candidateDialogBody.innerHTML = `
      <p class="candidate-dialog-stats">共 ${formatNumber(messages.length)} 条消息 · ${formatNumber(turns.length)} 个助手轮次 · ${formatNumber(candidate.usage?.totalTokens)} tokens · ${escapeHtml(stopReasonLabels[candidate.stopReason] ?? candidate.stopReason ?? '状态未知')}</p>
      ${messages.map((message, index) => conversationBlock(message, index)).join('')}`
  } catch (error) {
    elements.candidateDialogBody.innerHTML = `<p class="candidate-warning">无法加载完整对话：${escapeHtml(error.message)}</p>`
  }
}

elements.candidateDialogClose.addEventListener('click', () => elements.candidateDialog.close())

// Renders the streaming output dialog. Called on every job poll so the text
// the user sees updates live without reopening the dialog.
function renderLiveDialog() {
  const job = state.jobs.find((item) => item.id === state.liveJobId)
  if (!job || !job.live) {
    if (job) {
      // The job stopped streaming (awaiting selection or finished).
      elements.liveDialogBody.innerHTML = '<p class="muted">生成已结束，可从候选卡片查看完整对话。</p>'
    }
    return
  }
  const live = job.live
  const jobTitle = job.profile.toUpperCase()
  elements.liveDialogTitle.textContent = `实时生成输出 · ${jobTitle} · 候选 ${live.candidate} 第 ${live.subturn} 轮`
  const completed = (live.completed ?? []).filter((turn) => turn.toolNames.length).map((turn) => `
    <p>
      ${renderTools(turn.toolNames)}
      <span class="candidate-turn-line" title="${escapeHtml(turn.firstLine)}">${escapeHtml(turn.firstLine || '—')}</span>
    </p>`).join('')
  const reasoning = live.reasoningTail || '（等待首段推理…）'
  const content = live.contentTail || '（暂无正文）'
  elements.liveDialogBody.innerHTML = `
    ${completed ? `<div class="live-turns">${completed}</div>` : ''}
    <div class="live-stream-block">
      <p class="live-stream-label"><span class="pulse-dot"></span>推理中 · ${formatNumber(live.reasoningChars)} 字符</p>
      <pre class="conversation-reasoning">${escapeHtml(reasoning)}</pre>
    </div>
    <div class="live-stream-block">
      <p class="live-stream-label">正文 · ${formatNumber(live.contentChars)} 字符</p>
      <pre class="conversation-content">${escapeHtml(content)}</pre>
    </div>`
  const scroller = elements.liveDialogBody.querySelector('.conversation-reasoning')
  if (scroller) scroller.scrollTop = scroller.scrollHeight
}

elements.liveDialogClose.addEventListener('click', () => {
  elements.liveDialog.close()
  state.liveJobId = null
})

function openLiveDialog(jobId) {
  state.liveJobId = jobId
  renderLiveDialog()
  elements.liveDialog.showModal()
}

// Renders only this request's new input (the user/tool tail after the last
// assistant, or the user/tool messages when no assistant exists yet) plus the
// observed assistant reply. The full conversation history is intentionally
// not shown here.
function renderRequestMessages(entry) {
  const requestMessages = Array.isArray(entry.messages?.request) ? entry.messages.request : []
  const responseMessages = Array.isArray(entry.messages?.response) ? entry.messages.response : []
  const savedCurrent = Array.isArray(entry.messages?.currentInput)
    ? entry.messages.currentInput
    : null
  const currentInput = savedCurrent ?? GatewayTokenUtils.currentInputMessages(requestMessages)
  const inputMessages = currentInput ?? []
  if (!inputMessages.length && !responseMessages.length) {
    elements.messagesDialogBody.innerHTML = '<p class="muted">没有可查看的原始消息。</p>'
    return
  }
  const blocks = []
  if (inputMessages.length) {
    blocks.push('<p class="subheading">本次新增输入</p>')
    inputMessages.forEach((message, index) => blocks.push(conversationBlock(message, index)))
  }
  if (responseMessages.length) {
    const offset = inputMessages.length
    blocks.push('<p class="subheading">本次新回复</p>')
    responseMessages.forEach((message, index) => blocks.push(conversationBlock(message, offset + index)))
  }
  elements.messagesDialogTitle.textContent = `本次输入与新回复 · ${escapeHtml(entry.request?.model ?? '')}`
  elements.messagesDialogBody.innerHTML = blocks.join('')
}

function openRequestMessages(requestId) {
  const entry = state.entries.find((item) => item.requestId === requestId)
  if (!entry) {
    toast('找不到该请求')
    return
  }
  elements.messagesDialogBody.innerHTML = '<p class="muted">正在加载…</p>'
  elements.messagesDialog.showModal()
  renderRequestMessages(entry)
}

elements.messagesDialogClose.addEventListener('click', () => elements.messagesDialog.close())

const reasoningEffortLabels = {
  low: '低（low）',
  high: '高（high）',
  max: '最高（max）',
}

const continuationModeLabels = {
  'same-active-workstream': '延续同一工作流（same-active-workstream）',
  'completed-bootstrap': '已完成引导（completed-bootstrap）',
}

function renderAnchorToolStatus(anchor) {
  const called = new Set()
  for (const event of Array.isArray(anchor.toolEvents) ? anchor.toolEvents : []) {
    if (event?.name) called.add(event.name)
  }
  for (const turn of Array.isArray(anchor.assistantTurns) ? anchor.assistantTurns : []) {
    for (const name of Array.isArray(turn?.toolNames) ? turn.toolNames : []) called.add(name)
  }
  return renderBuilderToolStatus({
    toolStatus: {
      bash: called.has('bash'),
      strReplaceEditor: called.has('str_replace_editor'),
    },
  })
}

// Read-only Anchor viewer. Messages are rendered exactly as stored in the
// Artifact: old-format Anchors that still end on a tool result stay that way,
// with no synthetic assistant reply invented.
function renderAnchorView(anchor) {
  const requestSettings = anchor.requestSettings ?? {}
  const usage = anchor.usage ?? {}
  const continuation = anchor.continuation ?? {}
  const messages = Array.isArray(anchor.messages) ? anchor.messages : []
  const conversationComplete = messages.at(-1)?.role === 'assistant'
  const assistantTurns = Array.isArray(anchor.assistantTurns) ? anchor.assistantTurns : []
  const toolEvents = Array.isArray(anchor.toolEvents) ? anchor.toolEvents : []
  const completionTokens = usage.completionTokens != null ? Number(usage.completionTokens) : null
  const reasoningTokens = usage.reasoningTokens != null ? Number(usage.reasoningTokens) : null
  const contentTokens = Number.isFinite(completionTokens) && Number.isFinite(reasoningTokens)
    ? Math.max(0, completionTokens - reasoningTokens)
    : null
  const cacheHit = usage.cacheHitTokens != null ? Number(usage.cacheHitTokens) : null
  const cacheMiss = usage.cacheMissTokens != null ? Number(usage.cacheMissTokens) : null
  const cacheRate = Number.isFinite(cacheHit) && Number.isFinite(cacheMiss) && cacheHit + cacheMiss > 0
    ? cacheHit / (cacheHit + cacheMiss)
    : null
  const continuationText = String(continuation.message ?? '').trim()
  elements.anchorDialogTitle.textContent = `Anchor 只读查看 · ${anchor.model ?? '未知模型'}`
  elements.anchorDialogBody.innerHTML = `
    <div class="basic-stats anchor-meta-stats">
      <div class="basic-stat"><span>创建时间</span><b>${escapeHtml(formatTime(anchor.createdAt, true))}</b></div>
      <div class="basic-stat"><span>类型</span><b>${anchor.bundledDefault ? '内置默认' : '已生成'}</b></div>
      <div class="basic-stat"><span>绑定状态</span><b>${anchorIsBound(anchor) ? '当前绑定' : '未绑定'}</b></div>
      <div class="basic-stat"><span>对话完整性</span><b>${conversationComplete ? '完整（助手答复收尾）' : '旧格式（非助手答复收尾）'}</b></div>
      <div class="basic-stat"><span>推理强度</span><b>${escapeHtml(reasoningEffortLabels[requestSettings.reasoningEffort] ?? requestSettings.reasoningEffort ?? '—')}</b></div>
      <div class="basic-stat"><span>最大输出</span><b>${requestSettings.maxTokens != null ? `${formatNumber(requestSettings.maxTokens)} tokens` : '—'}</b></div>
      <div class="basic-stat"><span>消息数</span><b>${formatNumber(messages.length)}</b></div>
      <div class="basic-stat"><span>助手轮次</span><b>${formatNumber(assistantTurns.length)}</b></div>
      <div class="basic-stat"><span>工具事件</span><b>${formatNumber(toolEvents.length)}</b></div>
    </div>
    <dl class="fact-list">
      <div><dt>指纹</dt><dd><code>${escapeHtml(anchor.fingerprint ?? '—')}</code></dd></div>
      <div><dt>目录路径</dt><dd><code>${escapeHtml(anchor.path ?? '—')}</code></dd></div>
    </dl>
    <div class="basic-stats anchor-token-stats">
      <div class="basic-stat"><span>输入 tokens</span><b>${usage.promptTokens != null ? formatNumber(usage.promptTokens) : '—'}</b></div>
      <div class="basic-stat"><span>输出 tokens</span><b>${usage.completionTokens != null ? formatNumber(usage.completionTokens) : '—'}</b></div>
      <div class="basic-stat"><span>推理 tokens</span><b>${usage.reasoningTokens != null ? formatNumber(usage.reasoningTokens) : '—'}</b></div>
      <div class="basic-stat"><span>正文 tokens</span><b>${contentTokens != null ? formatNumber(contentTokens) : '—'}</b></div>
      <div class="basic-stat"><span>缓存命中</span><b>${usage.cacheHitTokens != null ? formatNumber(usage.cacheHitTokens) : '—'}</b></div>
      <div class="basic-stat"><span>未缓存输入</span><b>${usage.cacheMissTokens != null ? formatNumber(usage.cacheMissTokens) : '—'}</b></div>
      <div class="basic-stat"><span>缓存命中率</span><b>${formatPercent(cacheRate)}</b></div>
    </div>
    <p class="subheading">续接指令（continuation）</p>
    ${continuationText
      ? `<div class="continuation-block"><code>${escapeHtml(continuationModeLabels[continuation.mode] ?? continuation.mode ?? '—')}</code><pre class="conversation-content">${escapeHtml(continuationText)}</pre></div>`
      : '<p class="muted">未设置续接指令</p>'}
    <p class="subheading">工具调用状态</p>
    ${renderAnchorToolStatus(anchor)}
    <p class="subheading">完整消息（推理 / 正文 / 工具调用 / 工具结果）</p>
    ${messages.length
      ? messages.map((message, index) => conversationBlock(message, index)).join('')
      : '<p class="muted">该 Artifact 没有消息可展示</p>'}`
}

async function openAnchorView(anchorPath, anchorId) {
  elements.anchorDialogBody.innerHTML = '<p class="muted">正在加载只读内容…</p>'
  elements.anchorDialog.showModal()
  const params = new URLSearchParams()
  if (anchorPath) params.set('path', anchorPath)
  else if (anchorId) params.set('id', anchorId)
  try {
    const result = await fetchJson(`/__gateway/anchors/content?${params.toString()}`)
    renderAnchorView(result.anchor ?? {})
  } catch (error) {
    elements.anchorDialogTitle.textContent = 'Anchor 只读查看'
    elements.anchorDialogBody.innerHTML = `
      <p class="candidate-warning">无法打开 Anchor：${escapeHtml(error.message)}</p>
      <p class="muted">只读接口拒绝了该请求；文件可能不在 anchors/ 目录中，或 Artifact 指纹校验失败。</p>`
  }
}

elements.anchorDialogClose.addEventListener('click', () => elements.anchorDialog.close())

elements.anchorList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-view-anchor-path]')
  if (!button) return
  void openAnchorView(button.dataset.viewAnchorPath ?? '', button.dataset.viewAnchorId ?? '')
})

elements.anchorJobs.addEventListener('click', (event) => {
  const viewLive = event.target.closest('[data-view-live]')
  if (viewLive) {
    openLiveDialog(viewLive.dataset.viewLive)
    return
  }
  const viewButton = event.target.closest('[data-view-candidate]')
  if (viewButton) {
    void openCandidateConversation(viewButton.dataset.viewCandidate, viewButton.dataset.candidateIndex)
    return
  }
  const selectButton = event.target.closest('[data-select-candidate]')
  if (selectButton) {
    void pickJobAction(selectButton, 'select')
    return
  }
  const discardButton = event.target.closest('[data-discard-job]')
  if (discardButton) void pickJobAction(discardButton, 'discard')
})

function renderAnchorControls() {
  const profiles = state.config?.profiles ?? []
  const previous = elements.anchorProfile.value
  elements.anchorProfile.innerHTML = profiles.map((profile) => `
    <option value="${escapeHtml(profile.name)}" ${!profile.apiKeyConfigured ? 'disabled' : ''}>
      ${escapeHtml(profile.name.toUpperCase())} · ${escapeHtml(profile.model)}${!profile.apiKeyConfigured ? '（缺少 Key）' : !profile.enabled ? '（未启用，可先生成）' : ''}
    </option>`).join('')
  if (profiles.some((profile) => profile.name === previous && profile.apiKeyConfigured)) {
    elements.anchorProfile.value = previous
  }
  const submit = elements.anchorForm.querySelector('button[type="submit"]')
  submit.disabled = !elements.anchorProfile.value || state.jobs.some((job) =>
    ['queued', 'running'].includes(job.status) && job.profile === elements.anchorProfile.value)
  renderAnchorJobs()
}

function renderConfig() {
  const health = state.health
  if (!health) return
  const instances = gatewayInstances()
  if (['split', 'all'].includes(health.deploymentMode)) {
    elements.configList.innerHTML = `
      <div><dt>管理界面</dt><dd>${escapeHtml(location.origin)}</dd></div>
      <div><dt>管理父进程</dt><dd>PID ${escapeHtml(health.processId ?? '—')} · 结束后自动清理模型子进程</dd></div>
      <div><dt>部署模式</dt><dd>父子进程 · WebUI 管理父进程监管 ${instances.map((instance) => escapeHtml(instance.profile.toUpperCase())).join('、')} 数据子进程</dd></div>
      ${instances.map((instance) => `
        <div><dt>${escapeHtml(instance.profile)} 数据面</dt><dd>${escapeHtml(instance.baseUrl)} · 子进程 PID ${escapeHtml(instance.processId ?? '—')}</dd></div>
        <div><dt>${escapeHtml(instance.profile)} Key</dt><dd>${instance.gatewayApiKeyConfigured ? `${instance.gatewayApiKeySource === 'shared-fallback' ? '继承共享 Key' : '独立 Key'} · ${escapeHtml(instance.gatewayApiKeyPreview ?? '已配置')}` : '未配置 · 该端口不可用'}</dd></div>
      `).join('')}
      <div><dt>凭据策略</dt><dd>${escapeHtml(health.credentialPolicy ?? 'gateway-only')}</dd></div>
      <div><dt>版本</dt><dd>v${escapeHtml(health.version ?? '—')}</dd></div>`
    return
  }
  elements.configList.innerHTML = `
    <div><dt>上游地址</dt><dd>${escapeHtml(health.upstreamBaseUrl)}</dd></div>
    <div><dt>采集模式</dt><dd>${escapeHtml(health.captureMode)}</dd></div>
    <div><dt>管理鉴权</dt><dd>${health.managementAuthRequired ? '已启用' : '仅本机免令牌'}</dd></div>
    <div><dt>凭据策略</dt><dd>${escapeHtml(health.credentialPolicy ?? 'gateway-only')}</dd></div>
    <div><dt>Gateway Key</dt><dd>${health.gatewayApiKeyConfigured ? '已配置 · 唯一上游凭据' : '未配置 · 数据面不可用'}</dd></div>
    <div><dt>观测上限</dt><dd>${formatNumber(health.responseObservationLimitBytes)} bytes</dd></div>
    <div><dt>版本</dt><dd>v${escapeHtml(health.version ?? '—')}</dd></div>`
}

function renderAll() {
  const instances = gatewayInstances()
  elements.endpointValue.textContent = instances.length > 1
    ? instances.map((instance) => `${instance.profile} :${new URL(instance.baseUrl).port}`).join(' · ')
    : instances[0]?.baseUrl ?? `${location.origin}/v1`
  renderMetrics()
  renderRows()
  renderDetail()
  renderAnchors()
  renderDeployment()
  renderProfiles()
  renderAnchorControls()
  renderConfig()
}

async function loadData({ quiet = false, force = false } = {}) {
  if (state.loading && !force) return
  const epoch = ++loadEpoch
  state.loading = true
  if (!quiet) setConnection('waiting', '正在连接')
  elements.refreshButton.disabled = true
  try {
    const [health, diagnostics, config, jobs, anchorCatalog] = await Promise.all([
      fetchJson('/__gateway/health'),
      fetchJson('/__gateway/diagnostics?limit=500'),
      fetchOptionalJson('/__gateway/config', { profiles: [] }),
      fetchOptionalJson('/__gateway/anchors/jobs', { jobs: [] }),
      fetchOptionalJson('/__gateway/anchors', { anchors: [] }),
    ])
    if (epoch !== loadEpoch) return
    state.health = health
    state.config = config
    state.jobs = Array.isArray(jobs.jobs) ? jobs.jobs : []
    state.anchorCatalog = Array.isArray(anchorCatalog.anchors) ? anchorCatalog.anchors : []
    state.entries = Array.isArray(diagnostics.entries) ? diagnostics.entries : []
    state.retained = Number(diagnostics.retained ?? state.entries.length)
    state.markerProfile = diagnostics.markerProfile ?? health.trajectoryMarkerProfile ?? null
    if (!state.entries.some((entry) => entry.requestId === state.selectedId)) {
      state.selectedId = state.entries[0]?.requestId ?? null
    }
    const allKeysReady = health.allGatewayApiKeysConfigured ?? health.gatewayApiKeyConfigured
    setConnection(
      !health.gatewayApiKeyConfigured ? 'locked' : allKeysReady ? 'online' : 'waiting',
      !health.gatewayApiKeyConfigured
        ? '缺少 Gateway Key'
        : allKeysReady
          ? 'Gateway 在线'
          : '部分数据面缺少 Key',
    )
    elements.lastUpdated.textContent = `最后刷新 ${formatTime(new Date().toISOString())}`
    renderAll()
  } catch (error) {
    if (epoch !== loadEpoch) return
    if (error.status === 401) {
      setConnection('locked', '需要管理令牌')
      if (!elements.tokenDialog.open) elements.tokenDialog.showModal()
    } else {
      setConnection('offline', '连接失败')
      if (!quiet) toast('无法读取 Gateway 状态')
    }
  } finally {
    if (epoch === loadEpoch) {
      state.loading = false
      elements.refreshButton.disabled = false
    }
  }
}

function selectRequest(id) {
  state.selectedId = id
  renderRows()
  renderDetail()
}

elements.requestRows.addEventListener('click', (event) => {
  const row = event.target.closest('.request-row[data-request-id]')
  if (row) selectRequest(row.dataset.requestId)
})

elements.requestRows.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return
  const row = event.target.closest('.request-row[data-request-id]')
  if (!row) return
  event.preventDefault()
  selectRequest(row.dataset.requestId)
})

elements.detailPanel.addEventListener('click', (event) => {
  const messagesButton = event.target.closest('[data-view-messages]')
  if (messagesButton) {
    openRequestMessages(messagesButton.dataset.viewMessages)
    return
  }
  const button = event.target.closest('[data-copy-id]')
  if (button) copyText(button.dataset.copyId, '请求 ID 已复制')
})

elements.profileList.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-profile]')
  if (!form) return
  event.preventDefault()
  const submit = form.querySelector('button[type="submit"]')
  const data = new FormData(form)
  const patch = {
    enabled: data.get('enabled') === 'on',
    port: Number(data.get('port')),
    upstreamBaseUrl: String(data.get('upstreamBaseUrl') ?? '').trim(),
    enhancementMode: String(data.get('enhancementMode') ?? ''),
    anchorPath: String(data.get('anchorPath') ?? '').trim(),
    clearApiKey: data.get('clearApiKey') === 'on',
  }
  if (patch.enhancementMode === 'anchor' && !patch.anchorPath) {
    toast('Anchor 模式必须先绑定该模型自己生成的 Anchor；当前可使用 bypass')
    return
  }
  const apiKey = String(data.get('apiKey') ?? '').trim()
  if (apiKey) patch.apiKey = apiKey
  submit.disabled = true
  submit.textContent = '正在应用…'
  try {
    await fetchJson(`/__gateway/config/profiles/${encodeURIComponent(form.dataset.profile)}`, {
      method: 'PATCH',
      body: patch,
    })
    toast(`${form.dataset.profile.toUpperCase()} 配置已保存并生效`)
    await loadData({ quiet: true })
  } catch (error) {
    toast(`保存失败：${error.message}`)
    submit.disabled = false
    submit.textContent = `保存并热应用 ${form.dataset.profile.toUpperCase()}`
  }
})

elements.deploymentForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const submit = elements.deploymentForm.querySelector('button[type="submit"]')
  const patch = {
    mode: elements.deploymentMode.value,
    combinedPort: Number(elements.deploymentCombinedPort.value),
  }
  submit.disabled = true
  submit.textContent = '正在保存…'
  try {
    const result = await fetchJson('/__gateway/config/deployment', {
      method: 'PATCH',
      body: patch,
    })
    state.config = { ...(state.config ?? {}), deployment: result.deployment }
    renderDeployment()
    toast('部署方式已保存；重启 Gateway 后生效')
  } catch (error) {
    toast(`保存部署方式失败：${error.message}`)
  } finally {
    submit.disabled = false
    submit.textContent = '保存部署方式'
  }
})

function updateAnchorCostNote() {
  const runs = Number(elements.anchorRuns.value) || 0
  const subturns = Number(elements.anchorSubturns.value) || 0
  elements.anchorCostNote.textContent = `最多发起 ${runs * subturns} 次上游请求；实际通常更少。生成时使用该配置自己的 Gateway Key 和上游地址，配置未启用也可先生成。`
}

for (const input of [elements.anchorRuns, elements.anchorSubturns]) {
  input.addEventListener('input', updateAnchorCostNote)
}

elements.anchorProfile.addEventListener('change', renderAnchorControls)

elements.anchorForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const profile = elements.anchorProfile.value
  const runs = Number(elements.anchorRuns.value)
  const maxSubturns = Number(elements.anchorSubturns.value)
  const maxTokens = Number(elements.anchorMaxTokens.value)
  const anchorPrompt = elements.anchorPrompt.value.trim()
  const continuationMessage = elements.anchorContinuation.value.trim()
  const reasoningEffort = elements.anchorReasoningEffort.value
  const maximumCalls = runs * maxSubturns
  if (!window.confirm(`将为 ${profile.toUpperCase()} 生成专属 Anchor，最多发起 ${maximumCalls} 次计费上游请求。继续吗？`)) return
  const submit = elements.anchorForm.querySelector('button[type="submit"]')
  submit.disabled = true
  submit.textContent = '已启动生成任务'
  try {
    const result = await fetchJson('/__gateway/anchors/jobs', {
      method: 'POST',
      body: { profile, runs, maxSubturns, maxTokens, anchorPrompt, continuationMessage, reasoningEffort },
    })
    state.jobs = [result.job, ...state.jobs]
    renderAnchorControls()
    toast('Anchor 生成任务已启动；完成后请在任务卡片中挑选候选再保存')
  } catch (error) {
    toast(`无法启动：${error.message}`)
    submit.disabled = false
  } finally {
    submit.textContent = '开始生成'
  }
})

elements.searchInput.addEventListener('input', renderRows)
elements.statusFilter.addEventListener('change', renderRows)
elements.clearDiagnostics.addEventListener('click', async () => {
  if (!window.confirm('这会永久删除全部模型数据面的已保存请求统计、traffic 日志和 activity 日志，无法恢复。确定继续吗？')) return
  const confirmation = window.prompt('为防止误删，请准确输入：清空全部请求')
  if (confirmation !== '清空全部请求') {
    toast('确认文字不匹配，未清理任何数据')
    return
  }
  elements.clearDiagnostics.disabled = true
  try {
    const result = await fetchJson('/__gateway/diagnostics', {
      method: 'DELETE',
      body: { confirmation },
    })
    toast(`已清理 ${formatNumber(result.deleted)} 条请求记录`)
    loadEpoch++
    state.entries = []
    state.retained = 0
    state.selectedId = null
    renderAll()
    await loadData({ quiet: true, force: true })
  } catch (error) {
    toast(`清理失败：${error.message}`)
  } finally {
    elements.clearDiagnostics.disabled = false
  }
})
elements.refreshButton.addEventListener('click', () => loadData())
elements.copyEndpoint.addEventListener('click', () => copyText(endpointCopyValue(), 'Harness Base URL 已复制'))
elements.tokenButton.addEventListener('click', () => {
  elements.tokenInput.value = state.token
  elements.tokenDialog.showModal()
})

elements.tokenDialog.addEventListener('submit', (event) => {
  event.preventDefault()
  state.token = elements.tokenInput.value.trim()
  if (state.token) sessionStorage.setItem('gateway-management-token', state.token)
  else sessionStorage.removeItem('gateway-management-token')
  elements.tokenDialog.close()
  loadData()
})

elements.clearToken.addEventListener('click', () => {
  state.token = ''
  elements.tokenInput.value = ''
  sessionStorage.removeItem('gateway-management-token')
  elements.tokenDialog.close()
  loadData()
})

setInterval(() => {
  if (elements.autoRefresh.checked && !document.hidden) loadData({ quiet: true })
}, 5000)

setInterval(async () => {
  if (document.hidden) return
  if (!state.jobs.some((job) => ['queued', 'running', 'freezing'].includes(job.status))) return
  try {
    const result = await fetchJson('/__gateway/anchors/jobs')
    const jobs = Array.isArray(result.jobs) ? result.jobs : []
    const statusesNow = jobs.map((job) => `${job.id}:${job.status}`).join('|')
    const statusesBefore = state.jobs.map((job) => `${job.id}:${job.status}`).join('|')
    state.jobs = jobs
    renderAnchorJobs()
    if (state.liveJobId && elements.liveDialog.open) {
      renderLiveDialog()
    }
    if (statusesNow !== statusesBefore) {
      renderAnchorControls()
      if (jobs.some((job) => job.status === 'awaiting-selection')) {
        toast('候选已生成，请在任务卡片中挑选')
      }
    }
  } catch {
    // The 5-second full refresh remains the fallback for job updates.
  }
}, 1200)

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && elements.autoRefresh.checked) loadData({ quiet: true })
})

loadData()
