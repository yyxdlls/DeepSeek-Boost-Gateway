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
  inputFilter: $('input-filter'),
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
  anchorExample: $('anchor-example'),
  selectDialog: $('select-dialog'),
  selectForm: $('select-form'),
  selectDialogClose: $('select-dialog-close'),
  selectCancel: $('select-cancel'),
  selectDialogNote: $('select-dialog-note'),
  selectName: $('select-name'),
  selectError: $('select-error'),
  selectSubmit: $('select-submit'),
  microAnchorCreate: $('micro-anchor-create'),
  microAnchorWarning: $('micro-anchor-warning'),
  microAnchorApplyNote: $('micro-anchor-apply-note'),
  microAnchorDefinitions: $('micro-anchor-definitions'),
  microAnchorProfiles: $('micro-anchor-profiles'),
  microAnchorDialog: $('micro-anchor-dialog'),
  microAnchorForm: $('micro-anchor-form'),
  microAnchorDialogTitle: $('micro-anchor-dialog-title'),
  microAnchorDialogNote: $('micro-anchor-dialog-note'),
  microAnchorName: $('micro-anchor-name'),
  microAnchorContent: $('micro-anchor-content'),
  microAnchorContentField: $('micro-anchor-content-field'),
  microAnchorDialogError: $('micro-anchor-dialog-error'),
  microAnchorDialogClose: $('micro-anchor-dialog-close'),
  microAnchorDialogCancel: $('micro-anchor-dialog-cancel'),
  microAnchorDialogSubmit: $('micro-anchor-dialog-submit'),
  microAnchorViewDialog: $('micro-anchor-view-dialog'),
  microAnchorViewTitle: $('micro-anchor-view-title'),
  microAnchorViewBody: $('micro-anchor-view-body'),
  microAnchorViewClose: $('micro-anchor-view-close'),
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
  selectJobId: null,
  selectCandidateIndex: null,
  microAnchors: { cacheWarning: '', definitions: [], profiles: {} },
  microAnchorApply: {},
  microAnchorDialogState: null,
  token: sessionStorage.getItem('gateway-management-token') ?? '',
  // A: 可编辑面板（profiles/部署/微锚/config）的数据指纹；quiet 刷新只在其
  // 变化且焦点不在表单内时重绘，避免 5 秒自动刷新冲掉正在编辑的输入。
  configFingerprint: null,
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

// 可 hover / 键盘 focus 的帮助说明：button.help-icon + aria-describedby
// tooltip，不只依赖 title。tooltip 是按钮子元素，视觉上跟随按钮定位。
let helpIconSeq = 0

function helpIcon(text, ariaLabel = '帮助说明') {
  const id = `help-tip-${++helpIconSeq}`
  return `<button type="button" class="help-icon" aria-label="${escapeHtml(ariaLabel)}" aria-describedby="${id}"><span aria-hidden="true">?</span><span class="help-tooltip" role="tooltip" id="${id}">${escapeHtml(text)}</span></button>`
}

// 滚动容器（.candidate-dialog-body / .anchor-dialog-body / .detail-panel）的
// overflow-y:auto 会裁切绝对定位的 help tooltip。这些容器里的图标在 hover/
// focus 时把 tooltip 挂到 document.body（fixed 定位、图标上方），移出 / 失焦 /
// 滚动时交还；容器外的图标仍用纯 CSS 的原地 tooltip。
let bodyTooltip = null

function tooltipContainer(icon) {
  return icon.closest('.candidate-dialog-body, .anchor-dialog-body, .detail-panel')
}

function mountBodyTooltip(icon) {
  if (!tooltipContainer(icon)) return
  const bubble = icon.querySelector('.help-tooltip')
  if (!bubble) return
  if (bodyTooltip?.icon === icon) return
  unmountBodyTooltip()
  icon.classList.add('help-tooltip-detached')
  const rect = icon.getBoundingClientRect()
  const clone = document.createElement('span')
  const cloneId = `${bubble.id}-detached`
  clone.className = 'help-tooltip'
  clone.id = cloneId
  clone.setAttribute('role', 'tooltip')
  clone.textContent = bubble.textContent
  clone.style.position = 'fixed'
  clone.style.left = `${rect.left + rect.width / 2}px`
  clone.style.top = `${rect.top - 8}px`
  clone.style.transform = 'translateX(-50%) translateY(-100%)'
  clone.style.zIndex = '1000'
  clone.style.opacity = '1'
  clone.style.visibility = 'visible'
  clone.style.transition = 'none'
  document.body.appendChild(clone)
  icon.setAttribute('aria-describedby', cloneId)
  bodyTooltip = { icon, clone, previousId: bubble.id }
}

function unmountBodyTooltip() {
  if (!bodyTooltip) return
  bodyTooltip.icon.classList.remove('help-tooltip-detached')
  bodyTooltip.icon.setAttribute('aria-describedby', bodyTooltip.previousId)
  bodyTooltip.clone.remove()
  bodyTooltip = null
}

document.addEventListener('mouseover', (event) => {
  const icon = event.target.closest?.('.help-icon')
  if (icon) mountBodyTooltip(icon)
})
document.addEventListener('mouseout', (event) => {
  const icon = event.target.closest?.('.help-icon')
  if (icon && !icon.contains(event.relatedTarget)) unmountBodyTooltip()
})
document.addEventListener('focusin', (event) => {
  const icon = event.target.closest?.('.help-icon')
  if (icon) mountBodyTooltip(icon)
})
document.addEventListener('focusout', (event) => {
  const icon = event.target.closest?.('.help-icon')
  if (icon && !icon.contains(event.relatedTarget)) unmountBodyTooltip()
})
document.addEventListener('scroll', () => unmountBodyTooltip(), true)

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
    let payload = null
    try {
      payload = await response.json()
    } catch {
      // Keep the transport-level message.
    }
    const message = payload?.error?.message ?? `Gateway returned HTTP ${response.status}`
    const error = new Error(message)
    error.status = response.status
    error.payload = payload
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

function entryCurrentInput(entry) {
  const saved = entry?.messages?.currentInput
  if (Array.isArray(saved) && saved.length) return saved
  return GatewayTokenUtils.currentInputMessages(entry?.messages?.request) ?? []
}

// A request whose new input holds only tool results (no fresh user message)
// is a pure tool turn: the conversation continues from the tool side only.
function isToolOnlyInput(entry) {
  const current = entryCurrentInput(entry)
  if (!current.length) return false
  return current.every((message) => message?.role === 'tool')
}

function filteredEntries() {
  const query = elements.searchInput.value.trim().toLowerCase()
  const filter = elements.statusFilter.value
  const inputFilter = elements.inputFilter.value
  return state.entries.filter((entry) => {
    const status = requestState(entry)
    if (filter !== 'all' && status !== filter) return false
    if (inputFilter !== 'all') {
      const toolOnly = isToolOnlyInput(entry)
      if (toolOnly !== (inputFilter === 'tool-only')) return false
    }
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

// A: run-mode card shows deployment topology instead of health.mode
// (single-mode /health no longer exposes a single mode field).
const metricModeLabels = {
  single: '单端口',
  split: '三端口',
  all: '全开启',
}
const metricModeNotes = {
  single: '按 request.model 路由',
  split: '每端口一个模型',
  all: '多模型口 + 三单模型口',
}

function renderMetrics() {
  const health = state.health
  const complete = state.entries.filter((entry) => requestState(entry) === 'complete').length
  // A: 顶栏只汇总上游返回的推理 tokens；无 usage 的条目不计入，不用字符顶替。
  const reasoningTokenEntries = state.entries
    .map((entry) => {
      const reasoning = GatewayTokenUtils.tokensFromSummary(entry.response?.summary)?.reasoning
      return Number.isFinite(Number(reasoning)) ? Number(reasoning) : null
    })
    .filter((value) => value != null)
  const reasoningTokens = reasoningTokenEntries.reduce((sum, value) => sum + value, 0)
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
  const metricMode = health?.deploymentMode ?? 'single'
  $('metric-mode').textContent = health ? (metricModeLabels[metricMode] ?? '—') : '—'
  $('metric-mode-note').textContent = health
    ? !health.gatewayApiKeyConfigured
      ? '数据面等待 Gateway Key'
      : metricModeNotes[metricMode] ?? '等待 Gateway'
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
  $('metric-reasoning').textContent = state.entries.length ? formatNumber(reasoningTokens) : '—'
  $('metric-reasoning-note').textContent = state.entries.length
    ? reasoningTokenEntries.length
      ? `平均 ${formatNumber(Math.round(reasoningTokens / reasoningTokenEntries.length))} tokens / 请求`
      : '无 usage 的条目不计入'
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

function requestRowHtml(entry) {
  const status = requestState(entry)
  const summary = entry.response?.summary
  const tools = currentToolNames(entry)
  const tokens = GatewayTokenUtils.tokensFromSummary(summary)
  const reasoningChars = Number(summary?.reasoning?.chars ?? 0)
  const toolCount = Number(summary?.tools?.callCount ?? summary?.toolCallCount ?? 0)
  const inputValue = tokens?.input != null ? formatCompact(tokens.input) : '未返回'
  const outputValue = tokens?.output != null ? formatCompact(tokens.output) : '未返回'
  // 推理/正文没有 token 分项时显示「—」，绝不回退字符数；输入/输出没有
  // usage 时绝不冒充。
  const reasoningValue = tokens?.reasoning != null
    ? formatCompact(tokens.reasoning)
    : '—'
  const contentValue = tokens?.content != null
    ? formatCompact(tokens.content)
    : '—'
  // 缓存输入/命中率三态：未返回（none）/ 零（默认 amber）/ 有效命中（good）。
  const cacheInput = tokens?.cacheInput ?? null
  const hitRate = tokens?.hitRate ?? null
  const cacheInputState = cacheInput == null ? 'missing' : cacheInput > 0 ? 'good' : 'zero'
  const hitRateState = hitRate == null ? 'missing' : hitRate > 0 ? 'good' : 'zero'
  const cachePills = [
    `<span class="cache-pill ${cacheInputState === 'good' ? 'good' : cacheInputState === 'missing' ? 'none' : ''}" title="${cacheInputState === 'missing' ? '上游未返回缓存 token 数据' : cacheInputState === 'zero' ? '上游返回缓存输入为 0' : '上游返回有效缓存输入'}">缓存输入 ${cacheInput != null ? `${formatCompact(cacheInput)} tokens` : '未返回'}</span>`,
    `<span class="cache-pill ${hitRateState === 'good' ? 'good' : hitRateState === 'missing' ? 'none' : ''}" title="${hitRateState === 'missing' ? '上游未返回可计算的命中率' : hitRateState === 'zero' ? '有效缓存数据但命中率为 0' : '按已返回的缓存输入计算'}">命中率 ${hitRate != null ? formatPercent(hitRate) : '未返回'}</span>`,
  ].join('')
  const cot = summary?.reasoning?.cot
  const cotBadge = reasoningChars > 0 && cot?.label ? trajectoryBadge(cot) : ''
  const modeClass = String(entry.mode ?? '').startsWith('anchor') ? 'anchor' : ''
  const toolOnly = isToolOnlyInput(entry)
  return `
      <div data-request-id="${escapeHtml(entry.requestId)}" tabindex="0" role="listitem" class="request-row ${entry.requestId === state.selectedId ? 'selected' : ''}" aria-label="查看请求 ${escapeHtml(entry.requestId)}">
        <div class="row-line row-primary">
          <span class="row-time">${escapeHtml(formatTime(entry.startedAt))}</span>
          ${cotBadge}
          <span class="status-label ${status}">${stateLabels[status]}</span>
          <span class="mode-label ${modeClass}">${escapeHtml(entry.mode ?? '—')}</span>
          ${toolOnly ? '<span class="tool-only-badge" title="本次新增输入全部是工具结果，没有新的用户消息">纯工具调用</span>' : ''}
          <span class="row-model">${escapeHtml(entry.request?.model ?? shortId(entry.requestId))}${entry.profile ? ` · ${escapeHtml(entry.profile)}` : ''}</span>
          <span class="row-duration">${escapeHtml(formatDuration(entry.durationMs))}</span>
        </div>
        <div class="row-line row-secondary">
          <span class="io-flow">
            <b title="${tokens?.input != null ? `上游提示 ${formatNumber(tokens.input)} tokens` : '上游未返回 usage'}">输入 ${inputValue}${tokens?.input != null ? ' tokens' : ''}</b>
            <span class="io-arrow" aria-hidden="true">→</span>
            <b title="${tokens?.output != null ? `上游输出 ${formatNumber(tokens.output)} tokens（推理 ${tokens.reasoning != null ? formatNumber(tokens.reasoning) : '未返回'} · 正文 ${tokens.content != null ? formatNumber(tokens.content) : '未返回'}）` : '上游未返回 usage'}">输出 ${outputValue}${tokens?.output != null ? ' tokens' : ''}</b>
          </span>
          ${cachePills}
          <span class="io-detail">推理 ${reasoningValue}${tokens?.reasoning != null ? ' tokens' : ''} · 正文 ${contentValue}${tokens?.content != null ? ' tokens' : ''} · 工具 ${formatNumber(toolCount)} 次</span>
          ${tools.length ? renderTools(tools) : ''}
        </div>
      </div>`
}

function renderRows() {
  const entries = filteredEntries()
  if (!entries.length) {
    elements.requestRows.innerHTML = ''
    elements.requestEmpty.hidden = false
    elements.requestCount.textContent = state.entries.length
      ? '筛选后没有匹配的请求'
      : '暂无已保存诊断记录；完成或中断的请求会写入轮转日志'
    return
  }
  elements.requestRows.innerHTML = entries.map((entry) => requestRowHtml(entry)).join('')
  elements.requestEmpty.hidden = true
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
  // 只渲染「命中」的关键字（count>0），且只展示生成侧同一套 v3 八项。
  const ids = (profileIds.length ? profileIds : Object.keys(markers))
    .filter((id) => Number(markers[id] ?? 0) > 0)
  if (!ids.length) return '<p class="muted">未命中任何思维链关键字</p>'
  return `<div class="marker-grid">${ids.map((id) => {
    const count = Number(markers[id] ?? 0)
    const polarity = meta(id)?.polarity ?? 'diagnostic'
    const title = COT_POLARITY_TITLES[polarity] ?? '仅诊断'
    return `<span class="marker-chip ${polarity} hit" title="${title}">${escapeHtml(markerLabel(id))}<b>${formatNumber(count)}</b></span>`
  }).join('')}</div>`
}

function trajectoryBadge(cot) {
  if (!cot?.label) return '<span class="cot-label mixed">未分类</span>'
  const { progressive = 0, collective = 0, interruptive = 0 } = cot.counts ?? {}
  return `<span class="cot-label ${escapeHtml(cot.label)}" title="I'm …ing/我正在 ×${progressive} · we need/我们需要/let's/让我们 ×${collective} · let me/让我 ×${interruptive}">${escapeHtml(trajectoryLabel(cot.label))}</span>`
}

// A: highlighted「上下文占用」block placed above the generation stats.
// 主数字 = 生成记录里的总 tokens（usage.totalTokens；没有则「未返回」）；
// 副行 = 推理 tokens · 正文 tokens · 输入/输出（有则显示）。回放消息未经
// Provider 分词，不计算、不声称精确 token；字数/UTF-8 字节不再作为产品统计。
function renderContextOccupancy({
  usage = null,
  messageCount = null,
  cot = null,
  markers = null,
}) {
  const numbers = usage && typeof usage === 'object' ? usage : {}
  const numeric = (field) => {
    const value = numbers[field]
    return value != null && Number.isFinite(Number(value)) ? Number(value) : null
  }
  const totalTokens = numeric('totalTokens')
  const reasoningTokens = numeric('reasoningTokens')
  const completionTokens = numeric('completionTokens')
  const promptTokens = numeric('promptTokens')
  const contentTokens = completionTokens != null && reasoningTokens != null
    ? Math.max(0, completionTokens - reasoningTokens)
    : null
  const ioParts = []
  if (promptTokens != null) ioParts.push(`输入 ${formatNumber(promptTokens)} tokens`)
  if (completionTokens != null) ioParts.push(`输出 ${formatNumber(completionTokens)} tokens`)
  const hasUsage = totalTokens != null || reasoningTokens != null || promptTokens != null || completionTokens != null
  const hasCot = Boolean(cot?.label)
  const hasMarkers = Boolean(markers && Object.keys(markers).length)
  if (!hasUsage && !hasCot && !hasMarkers && messageCount == null) return ''
  const sideText = [
    reasoningTokens != null ? `推理 ${formatNumber(reasoningTokens)} tokens` : null,
    contentTokens != null ? `正文 ${formatNumber(contentTokens)} tokens` : null,
    ...ioParts,
  ].filter(Boolean).join(' · ')
  return `
    <div class="context-occupancy" aria-label="上下文占用">
      ${totalTokens != null ? `
      <div class="context-occupancy-main">
        <strong>${escapeHtml(formatNumber(totalTokens))}</strong>
        <span>生成记录总 tokens${messageCount != null ? ` · ${formatNumber(messageCount)} 条消息` : ''}</span>
      </div>` : ''}
      ${sideText ? `<div class="context-occupancy-side"><span>${escapeHtml(sideText)}</span></div>` : ''}
      ${hasCot ? `<div class="context-occupancy-cot">
        <span>思维链类型</span>
        ${trajectoryBadge(cot)}
      </div>` : ''}
      ${renderMarkers(markers)}
    </div>`
}

// 锚点外推理与 Anchor 历史共用同一字段集：推理 tokens、推理块、开头节选、
// 思维链类型、命中关键字。extra 用于给 Anchor 块追加「工具调用历史」。
function summaryBlock(title, scope, summary, note = '', extra = '') {
  if (!summary) {
    return `<section class="detail-block"><div class="detail-block-heading"><h3>${escapeHtml(title)}</h3><span class="scope-badge">${escapeHtml(scope)}</span></div><p class="muted">${escapeHtml(note || '没有可用统计')}</p></section>`
  }
  const reasoning = summary.reasoning ?? {}
  const tokens = GatewayTokenUtils.tokensFromSummary(summary)
  const hasReasoningTokens = tokens?.reasoning != null
  const reasoningValue = hasReasoningTokens
    ? formatNumber(tokens.reasoning)
    : '未返回'
  return `
    <section class="detail-block">
      <div class="detail-block-heading">
        <h3>${escapeHtml(title)}</h3>
        <span class="scope-badge">${escapeHtml(scope)}</span>
      </div>
      ${note ? `<p class="muted">${escapeHtml(note)}</p>` : ''}
      <div class="mini-metrics">
        <div class="mini-metric"><span>推理 tokens</span><strong>${reasoningValue}</strong></div>
        <div class="mini-metric"><span>推理块</span><strong>${formatNumber(reasoning.nonEmptyBlocks ?? reasoning.blocks)}</strong></div>
        <div class="mini-metric wide"><span title="第一句（到「。．.！!？?」为止）；无句号时保留前 40 个字符">开头节选</span><strong>${escapeHtml(openingPreview(reasoning))}</strong></div>
        <div class="mini-metric wide"><span>思维链</span><strong>${escapeHtml(trajectoryLabel(reasoning.cot?.label))}</strong></div>
      </div>
      <p class="subheading">思维链关键字</p>
      ${renderMarkers(reasoning.markers)}
      ${extra}
    </section>`
}

function basicInfoFacts(entry, summary) {
  const cache = cacheUsage(summary)
  const tokens = GatewayTokenUtils.tokensFromSummary(summary)
  const toolCalls = Number(summary?.tools?.callCount ?? summary?.toolCallCount ?? 0)
  const totalValue = tokens?.total != null
    ? `${formatNumber(tokens.total)} tokens`
    : '未返回'
  const inputValue = tokens?.input != null
    ? `${formatNumber(tokens.input)} tokens`
    : '未返回'
  const outputValue = tokens?.output != null
    ? `${formatNumber(tokens.output)} tokens`
    : '未返回'
  const reasoningValue = tokens?.reasoning != null
    ? `${formatNumber(tokens.reasoning)} tokens`
    : '未返回'
  const contentValue = tokens?.content != null
    ? `${formatNumber(tokens.content)} tokens`
    : '未返回'
  const cacheInput = tokens?.cacheInput ?? cache?.hitTokens
  const uncachedInput = tokens?.uncachedInput ?? cache?.missTokens
  const hitRate = tokens?.hitRate ?? cache?.hitRate
  const toolNames = summary?.tools?.names ?? summary?.toolNames ?? []
  return `
    <div class="basic-stat"><span>总 tokens</span><b>${totalValue}</b></div>
    <div class="basic-stat"><span>输入</span><b>${inputValue}</b></div>
    <div class="basic-stat"><span>输出</span><b>${outputValue}</b></div>
    <div class="basic-stat"><span>缓存输入</span><b>${cacheInput != null ? formatNumber(cacheInput) : '—'}</b></div>
    <div class="basic-stat"><span>未缓存输入</span><b>${uncachedInput != null ? formatNumber(uncachedInput) : '—'}</b></div>
    <div class="basic-stat"><span>命中率</span><b>${formatPercent(hitRate)}</b></div>
    <div class="basic-stat"><span>推理</span><b>${reasoningValue}</b></div>
    <div class="basic-stat"><span>正文</span><b>${contentValue}</b></div>
    <div class="basic-stat"><span>工具次数</span><b>${formatNumber(toolCalls)}</b></div>
    <div class="basic-stat wide"><span>工具序列</span><div class="basic-stat-value">${toolNames.length ? renderTools(toolNames) : '<span class="muted">无</span>'}</div></div>`
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

function diagnosticMicroAnchor(transformation) {
  const micro = transformation?.microAnchor
  const historyFingerprint = transformation?.thirdPartyHistoryFingerprint ?? null
  if (!micro && !historyFingerprint) return null
  const definition = micro?.id ? microAnchorDefinitionById(micro.id) : null
  const storedFingerprint = micro?.contentFingerprint ?? null
  const liveFingerprint = definition?.contentFingerprint ?? null
  return {
    micro,
    historyFingerprint,
    name: definition?.name ?? null,
    content: typeof definition?.content === 'string' ? definition.content : '',
    hasDefinition: Boolean(definition),
    fingerprintMatches: Boolean(storedFingerprint && liveFingerprint && storedFingerprint === liveFingerprint),
  }
}

function microAnchorTextBlock(diagnostic, { note } = {}) {
  if (!diagnostic) return ''
  if (diagnostic.content) {
    const mismatch = diagnostic.hasDefinition && diagnostic.micro?.contentFingerprint && !diagnostic.fingerprintMatches
      ? '<p class="muted">当前定义正文已变更；下面是现在的微锚点文本，不一定等于当时追加的内容。</p>'
      : ''
    return `${note ?? ''}${mismatch}<pre class="micro-anchor-content">${escapeHtml(diagnostic.content)}</pre>`
  }
  if (diagnostic.micro?.applied) {
    return `${note ?? ''}<p class="muted">当时追加过微锚点，但当前库里已找不到对应正文，只留下指纹。</p>`
  }
  return note ?? ''
}

function microAnchorDiagnosticBlock(transformation) {
  const diagnostic = diagnosticMicroAnchor(transformation)
  if (!diagnostic) return ''
  const micro = diagnostic.micro
  const reason = micro?.reason ?? (micro?.applied ? 'applied' : 'not-applied')
  const title = diagnostic.name || micro?.id || '微锚点'
  return `
    <section class="detail-block">
      <div class="detail-block-heading"><h3>微锚点信息</h3><span class="scope-badge">micro-anchor</span></div>
      ${microAnchorTextBlock(diagnostic, {
        note: `<p class="muted">${escapeHtml(diagnostic.name ? `本次使用「${diagnostic.name}」` : '本次使用的微锚点正文')}</p>`,
      })}
      <dl class="fact-list">
        <div><dt>名称</dt><dd>${escapeHtml(title)}</dd></div>
        <div><dt>开关</dt><dd>${micro?.enabled ? '开启' : '关闭'}</dd></div>
        <div><dt>保存项</dt><dd>${escapeHtml(micro?.id ?? '—')}</dd></div>
        <div><dt>来源</dt><dd>${escapeHtml(micro?.source ?? '—')}</dd></div>
        <div><dt>已追加</dt><dd>${micro?.applied ? `是 · ${formatNumber(micro.appliedUserMessageCount ?? 0)} 条 user` : '否'}</dd></div>
        <div><dt>原因</dt><dd>${escapeHtml(reason)}</dd></div>
        <div><dt>内容指纹</dt><dd><code>${escapeHtml(micro?.contentFingerprint ?? '—')}</code></dd></div>
        <div><dt>第三方历史指纹</dt><dd><code>${escapeHtml(diagnostic.historyFingerprint ?? '—')}</code></dd></div>
      </dl>
    </section>`
}

function renderDetail() {
  const entry = state.entries.find((item) => item.requestId === state.selectedId)
  if (!entry) {
    elements.detailPanel.innerHTML = `
      <div class="detail-placeholder">
        <span aria-hidden="true">↳</span>
        <h2>选择一次请求</h2>
        <p>这里先看锚点外推理和微锚点，再看基础信息与 Anchor 统计，并可查看本轮完整消息。</p>
      </div>`
    return
  }

  const status = requestState(entry)
  const responseSummary = entry.response?.summary
  const anchorHistory = entry.transformation?.anchorHistory
  const cache = cacheUsage(responseSummary)
  const hasMessages =
    (Array.isArray(entry.messages?.request) && entry.messages.request.length > 0) ||
    (Array.isArray(entry.messages?.response) && entry.messages.response.length > 0)

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

    ${summaryBlock('锚点外推理（本次回复）', '本次回复', responseSummary, '只统计这一次上游新生成的内容')}
    ${microAnchorDiagnosticBlock(entry.transformation)}

    <section class="detail-block">
      <div class="detail-block-heading"><h3>基础信息</h3><span class="scope-badge">usage</span></div>
      <div class="basic-stats">${basicInfoFacts(entry, responseSummary)}</div>
    </section>

    ${summaryBlock('锚点（Anchor 历史）', '锚点历史', anchorHistory, entry.transformation
      ? `Anchor ${entry.transformation.anchorId ?? '—'} · 注入 ${formatNumber(entry.transformation.anchorMessageCount ?? 0)} 条消息`
      : '本次请求没有注入 Anchor。', `<p class="subheading">工具调用历史</p>${renderTools(anchorHistory?.tools?.names ?? anchorHistory?.toolNames ?? [])}`)}

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
  // 产品列表只展示 default/user 混排；control 由服务端列表排除，
  // 前端再过滤一次以防未来后端字段变化。
  const catalog = state.anchorCatalog.filter(
    (artifact) => artifact.category !== 'control' && !artifact.copiedBaseline,
  )
  const bindings = loadBindings()
  if (!catalog.length) {
    elements.anchorList.innerHTML = bindings.length
      ? bindings.map((anchor) => `
      <div class="anchor-card bound">
        <div>
          <strong>${escapeHtml(anchor.model ?? '未知模型')}</strong>
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
    const categoryBadge = artifact.category === 'default'
      ? '<span class="anchor-badge default" title="模型原生示例 Anchor（默认）">模型默认</span>'
      : '<span class="anchor-badge generated" title="用户生成并保存的 Anchor">用户生成</span>'
    return `
    <div class="anchor-card ${bound ? 'bound' : ''}">
      <div>
        <strong>${escapeHtml(artifact.displayName ?? artifact.id ?? '未命名')}</strong>
        <small>${escapeHtml(artifact.model ?? '未知模型')}</small>
        <span class="anchor-badges">
          ${categoryBadge}
          ${bound ? '<span class="anchor-badge bound">当前绑定</span>' : ''}
        </span>
      </div>
      <div>
        <code title="${escapeHtml(artifact.fingerprint ?? '')}">SHA-256 ${escapeHtml(shortId(artifact.fingerprint, 20))}</code>
        <code title="${escapeHtml(artifact.path ?? '')}">${escapeHtml(artifact.path ?? '路径不可用')}</code>
      </div>
      <div class="anchor-card-actions">
        <button class="button ghost" type="button" data-view-anchor-path="${escapeHtml(artifact.path ?? '')}" data-view-anchor-id="${escapeHtml(artifact.id ?? '')}">只读查看</button>
        ${artifact.category === 'user'
          ? `<button class="button danger" type="button" data-delete-anchor-path="${escapeHtml(artifact.path ?? '')}" data-delete-anchor-id="${escapeHtml(artifact.id ?? '')}">删除</button>`
          : ''}
      </div>
    </div>`
  }).join('')
  const unmatchedCards = bindings
    .filter((bound) => !catalog.some((artifact) => bindingMatchesArtifact(bound, artifact)))
    .map((anchor) => `
    <div class="anchor-card bound">
      <div>
        <strong>${escapeHtml(anchor.model ?? '未知模型')}</strong>
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
    const availableAnchors = state.anchorCatalog.filter(
      (anchor) => anchor.model === profile.model &&
        anchor.category !== 'control' && !anchor.copiedBaseline,
    )
    if (profile.anchorPath && !availableAnchors.some((anchor) => (
      bindingMatchesArtifact({ path: profile.anchorPath }, anchor)
    ))) {
      availableAnchors.unshift({
        id: '当前配置（目录中未发现）',
        displayName: '当前配置（目录中未发现）',
        path: profile.anchorPath,
      })
    }
    const anchorOptions = [
      `<option value="" ${profile.anchorPath ? '' : 'selected'}>未绑定 Anchor（bypass 可用）</option>`,
      ...availableAnchors.map((anchor) => {
        const suffix = anchor.category === 'default'
          ? ' · 模型默认'
          : anchor.category === 'user'
            ? ' · 用户生成'
            : ''
        const selected = bindingMatchesArtifact({ path: profile.anchorPath }, anchor)
        return `<option value="${escapeHtml(anchor.path)}" ${selected ? 'selected' : ''}>${escapeHtml(anchor.displayName ?? anchor.id)}${suffix}</option>`
      }),
    ].join('')
    return `
    <article class="profile-card">
      <div class="profile-title">
        <div><strong>${escapeHtml(profile.name)}</strong></div>
        <span class="profile-state ${profile.running ? 'running' : ''}">${profile.running ? '运行中' : '已停止'}</span>
      </div>
      <form class="profile-form" data-profile="${escapeHtml(profile.name)}">
        <div class="profile-form-fields">
          <label class="toggle-field wide"><input name="enabled" type="checkbox" ${profile.enabled ? 'checked' : ''}><span>启用 ${escapeHtml(profile.name.toUpperCase())} 数据面</span></label>
          <label><span>数据端口</span><input name="port" type="number" min="1" max="65535" value="${escapeHtml(profile.port)}" required></label>
          <label><span>增强模式</span><select name="enhancementMode"><option value="anchor" ${profile.enhancementMode === 'anchor' ? 'selected' : ''}>anchor</option><option value="bypass" ${profile.enhancementMode === 'bypass' ? 'selected' : ''}>bypass</option></select></label>
          <label class="wide"><span>Harness 模型名</span>
            <div class="copy-field">
              <code>${escapeHtml(profile.model)}</code>
              <button class="button secondary" type="button" data-copy-id="${escapeHtml(profile.model)}">复制</button>
            </div>
          </label>
          <label class="wide"><span>上游模型名</span><input name="upstreamModel" type="text" value="${escapeHtml(profile.upstreamModel ?? '')}" placeholder="${escapeHtml(profile.model)}" spellcheck="false" autocomplete="off"></label>
          <label class="wide"><span>上游 Base URL</span><input name="upstreamBaseUrl" type="url" value="${escapeHtml(profile.upstreamBaseUrl)}" required spellcheck="false"></label>
          <label class="wide"><span>Gateway API Key</span><input name="apiKey" type="password" value="" placeholder="${profile.apiKeyConfigured ? '输入新 Key 可替换；留空保持不变' : '尚未配置'}" autocomplete="new-password" spellcheck="false">${keyPreview}</label>
          <label class="wide"><span>模型专属 Anchor</span><select name="anchorPath">${anchorOptions}</select></label>
          <label class="toggle-field wide"><input name="clearApiKey" type="checkbox"><span>保存时清除现有 Key</span></label>
        </div>
        <p class="form-note">Harness 接入时填写官方模型名；上游模型名只用于转发给外部 API，留空则与 Harness 模型名相同。测试回复会用当前已保存的地址、Key 和上游模型名发送「你好」。Key 只写入本机 <code>gateway.config.json</code>，页面只读取脱敏预览、绝不回传明文；无模型原生 Anchor 时先用 bypass，生成并绑定后再切换 anchor。</p>
        <p class="probe-result" data-probe-result="${escapeHtml(profile.name)}" hidden></p>
        <div class="profile-actions">
          <button class="button secondary" type="button" data-probe-profile="${escapeHtml(profile.name)}">测试回复</button>
          <button class="button primary" type="submit">保存并热应用 ${escapeHtml(profile.name.toUpperCase())}</button>
        </div>
      </form>
    </article>`
  }).join('')
}

const deploymentModeLabels = {
  split: '三端口 · 每端口一个模型',
  single: '一个多模型路由口 · 按 request.model 路由',
  all: '多模型路由口 + 三个单模型口',
}

function renderDeployment() {
  const deployment = state.config?.deployment ?? {
    mode: state.health?.deploymentMode ?? 'split',
    combinedPort: 8646,
  }
  elements.deploymentMode.value = deployment.mode ?? 'split'
  elements.deploymentCombinedPort.value = deployment.combinedPort ?? 8646
  elements.deploymentNote.textContent = `当前运行：${deploymentModeLabels[state.health?.deploymentMode] ?? state.health?.deploymentMode ?? '未知'}；保存后需重启才切换拓扑。8646 只在“多模型路由口 + 三个单模型口”时使用。`
}

const jobStatusLabels = {
  queued: '排队中',
  running: '生成中',
  'awaiting-selection': '待挑选候选',
  'reserving-name': '正在保存',
  freezing: '正在保存',
  saved: '已保存',
  'saved-not-activated': '已保存，绑定失败',
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
  // A: 直播标题只报上游返回的推理 tokens；没有 usage 时只写「推理中」。
  const reasoningTokens = usage?.reasoningTokens != null ? Number(usage.reasoningTokens) : null
  const reasoningTitle = reasoningTokens != null
    ? `已输出推理 ${formatNumber(reasoningTokens)} tokens`
    : '推理中'
  return `
    <div class="job-progress">
      <p class="job-progress-title"><span class="pulse-dot"></span>${candidateText} · ${reasoningTitle}</p>
      <div class="job-live-stats">
        <span>输入 <b>${inputTokens ? `${formatCompact(inputTokens)} tokens` : '—'}</b></span>
        <span>输出 <b>${outputTokens ? `${formatCompact(outputTokens)} tokens` : '—'}</b></span>
        <span>缓存命中 <b>${cacheTotal ? formatPercent(cacheRate) : '—'}</b></span>
        <span>工具 <b>${tools}</b> 次</span>
      </div>
      <p class="job-live-line" title="${escapeHtml(reasoningTail)}">${escapeHtml(reasoningTail)}</p>
      <div class="job-progress-actions">
        <button class="button ghost" type="button" data-view-live="${escapeHtml(job.id)}">查看实时输出</button>
      </div>
    </div>`
}

function renderCandidateList(job) {
  if (!job.candidates?.length || job.status === 'discarded') return ''
  const selectable = job.status === 'awaiting-selection'
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
        const totalTokens = usage.totalTokens != null ? Number(usage.totalTokens) : null
        const reasoningTokens = usage.reasoningTokens != null ? Number(usage.reasoningTokens) : null
        const contentTokens = usage.completionTokens != null && reasoningTokens != null && reasoningTokens <= outputTokens
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
              ${selectable
                ? `<button class="button primary candidate-select" type="button" data-select-candidate="${escapeHtml(job.id)}" data-candidate-index="${candidate.candidateIndex}">选用并保存</button>`
                : job.selectedCandidate === candidate.candidateIndex
                  ? '<span class="muted">已选用</span>'
                  : ''}
            </div>
          </div>
          <div class="basic-stats">
            <div class="basic-stat"><span>总 tokens</span><b>${totalTokens != null ? `${formatNumber(totalTokens)} tokens` : '—'}</b></div>
            <div class="basic-stat"><span>输入</span><b>${inputTokens ? `${formatNumber(inputTokens)} tokens` : '—'}</b></div>
            <div class="basic-stat"><span>输出</span><b>${outputTokens ? `${formatNumber(outputTokens)} tokens` : '—'}</b></div>
            <div class="basic-stat"><span>缓存输入</span><b>${formatNumber(cacheHit)} tokens</b></div>
            <div class="basic-stat"><span>命中率</span><b>${formatPercent(cacheRate)}</b></div>
            <div class="basic-stat"><span>工具</span><b>${formatNumber(candidate.totalToolCalls)}</b></div>
            <div class="basic-stat"><span>推理</span><b>${reasoningTokens != null ? `${formatNumber(reasoningTokens)} tokens` : '—'}</b></div>
            <div class="basic-stat"><span>正文</span><b>${contentTokens != null ? `${formatNumber(contentTokens)} tokens` : '—'}</b></div>
            <div class="basic-stat wide"><span>开头预览</span><b>${escapeHtml(candidate.openingPreview || '—')}</b></div>
          </div>
          <p class="subheading">工具调用状态 ${helpIcon('仅表示生成轨迹中是否完成对应调用，不代表质量判定。')}</p>
          ${renderBuilderToolStatus(candidate)}
          <p class="subheading">思维链关键字</p>
          ${renderMarkers(candidate.markers)}
          <p class="candidate-facts-note">生成状态：${escapeHtml(stopReasonLabels[candidate.stopReason] ?? candidate.stopReason ?? '—')}</p>
        </div>`
      }).join('')}
    </div>
`
}

function jobDetail(job) {
  if (job.error) {
    return escapeHtml(job.error)
  }
  if (job.status === 'awaiting-selection') {
    return `${job.candidates?.length ?? 0} 个候选已生成，请根据自然输出挑选`
  }
  if (job.status === 'succeeded') {
    return `${job.runs} 个候选 · 已保存候选 ${job.selectedCandidate ?? '—'} · ${job.displayName ? `名称 ${escapeHtml(job.displayName)}` : ''}${job.artifactPath ? ` · ${escapeHtml(job.artifactPath)}` : ''}`
  }
  if (['saved', 'saved-not-activated'].includes(job.status)) {
    return `${job.runs} 个候选 · 已保存候选 ${job.selectedCandidate ?? '—'} · ${job.displayName ? `名称 ${escapeHtml(job.displayName)}` : ''}${job.artifactPath ? ` · ${escapeHtml(job.artifactPath)}` : ''}${job.status === 'saved-not-activated' ? ' · 已保存但未绑定，请重新绑定' : ''}`
  }
  return `${job.runs} 个候选 · 思考强度 ${escapeHtml(job.reasoningEffort ?? 'max')} · 最多 ${job.maximumUpstreamCalls} 次请求${job.artifactPath ? ` · ${escapeHtml(job.artifactPath)}` : ''}`
}

function renderAnchorJobs() {
  if (!state.jobs.length) {
    elements.anchorJobs.innerHTML = ''
    return
  }
  elements.anchorJobs.innerHTML = state.jobs.slice(0, 5).map((job) => {
    const detail = jobDetail(job)
    const expanded = ['awaiting-selection', 'running', 'queued', 'saved-not-activated', 'reserving-name', 'failed'].includes(job.status)
      || Boolean(job.candidates?.length)
    const rowActions = [
      job.status === 'awaiting-selection'
        ? `<button class="button ghost" type="button" data-discard-job="${escapeHtml(job.id)}">放弃本轮生成</button>`
        : '',
      job.status === 'saved-not-activated'
        ? `<button class="button primary" type="button" data-activate-job="${escapeHtml(job.id)}">重新绑定</button>`
        : '',
    ].filter(Boolean)
    const actions = rowActions.length
      ? `<div class="job-row-actions">${rowActions.join('')}</div>`
      : ''
    return `
    <div class="job-card ${job.status === 'running' || job.status === 'queued' ? 'running' : ''} ${expanded ? 'expanded' : ''}">
      <div class="job-row">
        <div>
          <strong>${escapeHtml(job.profile.toUpperCase())} · ${escapeHtml(job.anchorId ?? '未命名 Anchor')}</strong>
          <small>${detail}</small>
        </div>
        <span class="job-status ${escapeHtml(job.status)}">${escapeHtml(jobStatusLabels[job.status] ?? job.status)}</span>
      </div>
      ${actions}
      ${renderJobProgress(job)}
      ${renderCandidateList(job)}
    </div>`
  }).join('')
}

function updateJobFromResult(job) {
  const index = state.jobs.findIndex((item) => item.id === job.id)
  if (index !== -1) state.jobs[index] = job
}

async function refreshJobsQuiet() {
  try {
    const result = await fetchJson('/__gateway/anchors/jobs')
    state.jobs = Array.isArray(result.jobs) ? result.jobs : []
    renderAnchorJobs()
  } catch {
    // Keep the current list; the next full refresh will repair it.
  }
}

async function activateSavedJob(button, jobId) {
  const job = state.jobs.find((item) => item.id === jobId)
  if (!job) return
  button.disabled = true
  try {
    const result = await fetchJson(`/__gateway/anchors/jobs/${encodeURIComponent(jobId)}/activate`, {
      method: 'POST',
      body: {},
    })
    updateJobFromResult(result.job)
    renderAnchorJobs()
    renderAnchorControls()
    toast(result.job.status === 'succeeded'
      ? `已保存并绑定到 ${result.job.profile.toUpperCase()}`
      : `重新绑定未完成：${result.job.error ?? '未知原因'}`)
    void loadData({ quiet: true })
  } catch (error) {
    toast(`重新绑定失败：${error.message}`)
    button.disabled = false
    void refreshJobsQuiet()
  }
}

function openSelectDialog(jobId, candidateIndex) {
  const job = state.jobs.find((item) => item.id === jobId)
  if (!job) return
  if (elements.selectDialog.open) return
  // 工具调用不是保存门槛：缺 bash / view 只在卡片上标「未调用」，
  // 不再弹确认、也不拦保存。硬拦仍只在服务端（unsafe / 无完整末轮
  // assistant / 指纹·模型·夹具不匹配）。
  state.selectJobId = jobId
  state.selectCandidateIndex = Number(candidateIndex)
  elements.selectDialogNote.textContent = `候选 ${candidateIndex} · ${job.profile.toUpperCase()} · 保存生成机器 id/path 后尝试绑定 ${job.profile.toUpperCase()} 数据面`
  elements.selectName.value = ''
  elements.selectError.hidden = true
  elements.selectError.textContent = ''
  elements.selectSubmit.disabled = false
  elements.selectDialog.showModal()
  elements.selectName.focus()
}

async function pickJobAction(button, action) {
  if (action === 'activate') {
    const activateJobId = button.dataset.activateJob
    if (!activateJobId) return
    await activateSavedJob(button, activateJobId)
    return
  }
  const jobId = button.dataset.discardJob
  const job = state.jobs.find((item) => item.id === jobId)
  if (!job) return
  if (!window.confirm('将放弃本轮生成的全部候选，结果文件也会一并删除，已产生的上游费用不会退回。确定继续吗？')) return
  button.disabled = true
  try {
    const result = await fetchJson(`/__gateway/anchors/jobs/${encodeURIComponent(jobId)}/discard`, {
      method: 'POST',
      body: {},
    })
    updateJobFromResult(result.job)
    renderAnchorJobs()
    renderAnchorControls()
    toast('本轮生成已放弃')
    void loadData({ quiet: true })
  } catch (error) {
    toast(`操作失败：${error.message}`)
    button.disabled = false
  }
}

elements.selectDialogClose.addEventListener('click', () => {
  elements.selectDialog.close()
  state.selectJobId = null
  state.selectCandidateIndex = null
})
elements.selectCancel.addEventListener('click', () => {
  elements.selectDialog.close()
  state.selectJobId = null
  state.selectCandidateIndex = null
})

elements.selectForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const jobId = state.selectJobId
  const candidateIndex = state.selectCandidateIndex
  if (!jobId || candidateIndex == null) return
  const displayName = elements.selectName.value.trim()
  if (displayName.length < 1 || displayName.length > 80) {
    elements.selectError.textContent = '名称必须为 1–80 个字符（首尾空白会被忽略）。'
    elements.selectError.hidden = false
    return
  }
  const submit = elements.selectSubmit
  submit.disabled = true
  try {
    const result = await fetchJson(`/__gateway/anchors/jobs/${encodeURIComponent(jobId)}/select`, {
      method: 'POST',
      body: { candidate: candidateIndex, displayName, activate: true },
    })
    updateJobFromResult(result.job)
    elements.selectDialog.close()
    state.selectJobId = null
    state.selectCandidateIndex = null
    if (result.job.status === 'succeeded') {
      toast(`已保存并绑定到 ${result.job.profile.toUpperCase()}`)
    } else if (result.job.status === 'saved-not-activated') {
      toast('已保存，但绑定数据面失败；请在任务卡片中重新绑定')
    } else {
      toast('已保存；未自动绑定')
    }
    renderAnchorControls()
    void loadData({ quiet: true })
  } catch (error) {
    if (error.status === 400) {
      elements.selectError.textContent = error.message
      elements.selectError.hidden = false
      submit.disabled = false
      return
    }
    if (error.status === 409) {
      // 保存可能已部分完成（重名冲突没有落盘 / CAS 冲突已保存未绑定）。
      // 回读服务端任务状态再决定对话框去留。
      submit.disabled = false
      await refreshJobsQuiet()
      const job = state.jobs.find((item) => item.id === jobId)
      if (job?.status === 'awaiting-selection') {
        elements.selectError.textContent = error.message
        elements.selectError.hidden = false
        return
      }
      elements.selectDialog.close()
      state.selectJobId = null
      state.selectCandidateIndex = null
      if (job?.status === 'saved-not-activated') {
        toast('已保存，但绑定数据面失败；请在任务卡片中重新绑定')
      } else {
        toast(`保存失败：${error.message}`)
      }
      renderAnchorControls()
      return
    }
    submit.disabled = false
    await refreshJobsQuiet()
    elements.selectError.textContent = error.message
    elements.selectError.hidden = false
  }
})

// 对话角色在界面上的统一解释。user 是用户/引导请求；assistant 是模型消息
// 容器（可同含思维链、正文和工具调用）；tool 只代表对应调用的工具结果，
// 不等于本轮最终回复。
const roleLegendLabels = {
  system: '系统指令',
  developer: '开发者指令',
  user: '用户 / 引导请求',
  assistant: '模型消息',
  tool: '仅工具结果',
}

// cat -n 风格输出只在展示层紧凑化：整段至少两行匹配 `^ *\d+\t` 时，
// 解析为「行号列 + 正文列」两栏；否则返回 null，由调用方保持原样 <pre>。
// 不改原字符串、日志或 fingerprint。
const CATN_PATTERN = /^ *\d+\t/

function catNTable(text) {
  if (typeof text !== 'string') return null
  const lines = text.split('\n')
  const matched = lines.filter((line) => CATN_PATTERN.test(line)).length
  if (matched < 2) return null
  const fields = lines.map((line) => {
    const match = line.match(CATN_PATTERN)
    if (!match) return `<span class="catn-plain">${escapeHtml(line)}</span>`
    return `<span class="catn-no">${escapeHtml(match[0].trim())}</span><span class="catn-text">${escapeHtml(line.slice(match[0].length))}</span>`
  })
  return `<div class="catn-table">${fields.join('')}</div>`
}

function renderMicroAnchorSuffix(content) {
  if (!content) return '<span class="muted">\n\n（当时追加过微锚点，当前库里已找不到对应正文）</span>'
  return `<span class="micro-anchor-inline">${escapeHtml(`\n\n${content}`)}</span>`
}

function renderConversationContent(content, coloredSuffix = null) {
  const suffixHtml = coloredSuffix != null ? renderMicroAnchorSuffix(coloredSuffix) : ''
  if (typeof content !== 'string' || content === '') {
    return suffixHtml ? `<pre class="conversation-content">${suffixHtml}</pre>` : null
  }
  const catn = catNTable(content)
  if (catn) return suffixHtml ? `${catn}<pre class="conversation-content">${suffixHtml}</pre>` : catn
  return `<pre class="conversation-content">${escapeHtml(content)}${suffixHtml}</pre>`
}

// 共用入口：先预计算「tool-call id → 该消息序号」映射，再逐条渲染。
// 三个对话弹窗（候选 / 本次请求 / Anchor 只读）共用同一渲染器与语义。

function conversationBlocks(messages, offset = 0, options = {}) {
  const list = Array.isArray(messages) ? messages : []
  if (!list.length) return ''
  const callToIndex = new Map()
  let lastAssistantIndex = -1
  const resultToIndex = new Map()
  list.forEach((message, index) => {
    if (message?.role === 'tool' && message?.tool_call_id) {
      resultToIndex.set(String(message.tool_call_id), index)
    }
    if (message?.role !== 'assistant') return
    lastAssistantIndex = index
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
      if (call?.id) callToIndex.set(String(call.id), index)
    }
  })
  return list.map((message, index) => conversationBlock(message, index, {
    offset,
    callToIndex,
    resultToIndex,
    lastAssistantIndex,
    attachMicroAnchor: Boolean(options.attachMicroAnchor),
    microAnchorContent: options.microAnchorContent ?? '',
  })).join('')
}

function conversationBlock(message, index, context = {}) {
  const role = message?.role ?? 'unknown'
  const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : ''
  const content = typeof message?.content === 'string' ? message.content
    : Array.isArray(message?.content) ? message.content.map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : JSON.stringify(part)).join('\n') : ''
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  const offset = Number(context.offset ?? 0)
  const number = index + 1 + offset
  const isAssistant = role === 'assistant'
  const isTool = role === 'tool'
  const isFinalReply = isAssistant && index === context.lastAssistantIndex && !calls.length && Boolean(content)
  const callIndex = context.callToIndex ?? new Map()
  const metaSpans = []
  if (isTool) {
    const callId = String(message?.tool_call_id ?? '')
    if (callId) metaSpans.push(`<span class="tool-call-ref">call id <code>${escapeHtml(callId)}</code></span>`)
    const owner = callIndex.get(callId)
    metaSpans.push(owner != null
      ? `<span class="tool-call-ref">对应调用 #${owner + 1 + offset}</span>`
      : '<span class="tool-call-ref">对应调用在会话更早部分，未在本次展示范围</span>')
  }
  const sections = []
  if (isAssistant) {
    if (reasoning) {
      sections.push(`<div class="conversation-section"><span class="conversation-section-label">思维链</span><pre class="conversation-reasoning">${escapeHtml(reasoning)}</pre></div>`)
    }
    if (content) {
      sections.push(`<div class="conversation-section"><span class="conversation-section-label">正文</span>${renderConversationContent(content)}</div>`)
    }
    if (calls.length) {
      sections.push(`<div class="conversation-section"><span class="conversation-section-label">工具调用${calls.length > 1 ? ` · ${calls.length} 个` : ''}</span><div class="tool-call-list">${calls.map((call) => {
        const id = String(call?.id ?? '—')
        const name = call?.function?.name ?? 'tool'
        const args = String(call?.function?.arguments ?? '')
        const argsPreview = args.length > 200 ? `${args.slice(0, 200)}…` : args
        const responder = (context.resultToIndex ?? new Map()).get(id)
        return `<div class="tool-call">
          <div class="tool-call-head"><b>${escapeHtml(name)}</b><code>${escapeHtml(id)}</code></div>
          <div class="tool-call-detail">${argsPreview ? `<span>参数 ${escapeHtml(argsPreview)}</span>` : ''}${responder != null ? `<span>→ 工具结果 #${responder + 1 + offset}</span>` : ''}</div>
        </div>`
      }).join('')}</div></div>`)
    }
    if (!sections.length) sections.push('<pre class="conversation-content muted">（空消息）</pre>')
  } else {
    const suffix = role === 'user' && context.attachMicroAnchor
      ? (context.microAnchorContent ?? '')
      : null
    const contentBlock = renderConversationContent(content, suffix)
    if (contentBlock) sections.push(contentBlock)
    else if (!reasoning && !calls.length) sections.push('<pre class="conversation-content muted">（空消息）</pre>')
  }
  const showFullMessage = Boolean(reasoning) || Boolean(content) ||
    calls.some((call) => String(call?.function?.arguments ?? '').length > 0)
  const fullMessageView = showFullMessage
    ? `<details class="message-full-details">
      <summary class="message-full-button">查看完整消息</summary>
      <div class="message-full-body">
        ${reasoning ? `<p class="message-full-label">思维链</p><pre class="conversation-reasoning">${escapeHtml(reasoning)}</pre>` : ''}
        ${content || (role === 'user' && context.attachMicroAnchor) ? `<p class="message-full-label">正文</p><pre class="conversation-content">${escapeHtml(content ?? '')}${role === 'user' && context.attachMicroAnchor ? renderMicroAnchorSuffix(context.microAnchorContent) : ''}</pre>` : ''}
        ${calls.length ? `<p class="message-full-label">工具调用 · ${calls.length}</p><div class="tool-call-list">${calls.map((call) => {
          const id = String(call?.id ?? '—')
          const name = call?.function?.name ?? 'tool'
          const args = String(call?.function?.arguments ?? '')
          return `<div class="tool-call">
            <div class="tool-call-head"><b>${escapeHtml(name)}</b><code>${escapeHtml(id)}</code></div>
            <pre class="conversation-content">${escapeHtml(args || '（无参数）')}</pre>
          </div>`
        }).join('')}</div>` : ''}
      </div>
    </details>`
    : ''
  return `
    <div class="conversation-item ${escapeHtml(role)} ${isFinalReply ? 'final' : ''}">
      <div class="conversation-meta">
        <b>#${number} ${escapeHtml(roleLegendLabels[role] ?? role)}${isFinalReply ? ' · 最终回复' : ''}</b>
        ${metaSpans.join('')}
      </div>
      ${sections.join('')}
      ${fullMessageView}
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
      <p class="candidate-dialog-stats">共 ${formatNumber(messages.length)} 条消息 · ${formatNumber(turns.length)} 个助手轮次 · ${candidate.usage?.totalTokens != null ? `${formatNumber(candidate.usage.totalTokens)} tokens` : '—'} · ${escapeHtml(stopReasonLabels[candidate.stopReason] ?? candidate.stopReason ?? '状态未知')}</p>
      ${conversationBlocks(messages)}`
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
  // A: 直播弹窗只报上游返回的 token 分项；没有 usage 时只写「推理中」/「正文」。
  const usage = live.usage
  const liveReasoningTokens = usage?.reasoningTokens != null ? Number(usage.reasoningTokens) : null
  const liveCompletionTokens = usage?.completionTokens != null ? Number(usage.completionTokens) : null
  const liveContentTokens = liveCompletionTokens != null && liveReasoningTokens != null
    ? Math.max(0, liveCompletionTokens - liveReasoningTokens)
    : null
  elements.liveDialogBody.innerHTML = `
    ${completed ? `<div class="live-turns">${completed}</div>` : ''}
    <div class="live-stream-block">
      <p class="live-stream-label"><span class="pulse-dot"></span>${liveReasoningTokens != null ? `推理中 · ${formatNumber(liveReasoningTokens)} tokens` : '推理中'}</p>
      <pre class="conversation-reasoning">${escapeHtml(reasoning)}</pre>
    </div>
    <div class="live-stream-block">
      <p class="live-stream-label">正文${liveContentTokens != null ? ` · ${formatNumber(liveContentTokens)} tokens` : ''}</p>
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
  const responseMessages = Array.isArray(entry.messages?.response) ? entry.messages.response : []
  const inputMessages = entryCurrentInput(entry)
  const diagnostic = diagnosticMicroAnchor(entry.transformation)
  const hasMicro = Boolean(diagnostic?.micro?.applied)
  const inputHasUser = inputMessages.some((message) => message?.role === 'user')
  if (!inputMessages.length && !responseMessages.length) {
    elements.messagesDialogBody.innerHTML = '<p class="muted">没有可查看的原始消息。</p>'
    return
  }
  const blocks = []
  if (hasMicro) {
    blocks.push(inputHasUser
      ? '<p class="muted">微锚点已接到每条第三方 user 正文末尾（青色）。</p>'
      : '<p class="muted">微锚点已接到更早的第三方 user 正文末尾；本次新增输入里没有 user 消息。</p>')
  }
  if (inputMessages.length) {
    blocks.push('<p class="subheading">本次新增输入</p>')
    blocks.push(conversationBlocks(inputMessages, 0, {
      attachMicroAnchor: hasMicro,
      microAnchorContent: diagnostic?.content ?? '',
    }))
  }
  if (responseMessages.length) {
    const offset = inputMessages.length
    blocks.push('<p class="subheading">本次新回复</p>')
    blocks.push(conversationBlocks(responseMessages, offset))
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
  const trajectoryStats = anchor.trajectoryStats ?? {}
  const trajectoryReasoning = trajectoryStats.reasoning ?? {}
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
    ${messages.length
      ? renderContextOccupancy({
          usage,
          messageCount: messages.length,
          cot: trajectoryReasoning.cot ?? null,
          markers: trajectoryReasoning.markers ?? null,
        })
      : ''}
    <p class="subheading">生成统计 ${helpIcon('以下统计来自该 Artifact 保存时的生成记录；更早保存的 Artifact 若未以助手答复收尾，不补造助手答复。')}</p>
    <div class="basic-stats anchor-meta-stats">
      <div class="basic-stat"><span title="Artifact 保存时间；只读展示，不提供编辑">创建时间</span><b>${escapeHtml(formatTime(anchor.createdAt, true))}</b></div>
      <div class="basic-stat"><span title="内置默认示例为模型专属默认（只读）；用户生成为 Builder 生成并保存">来源</span><b>${anchor.category === 'default' ? '内置默认示例' : anchor.category === 'control' ? '实验控制项' : '用户生成'}</b></div>
      <div class="basic-stat"><span title="是否被某模型数据面当前绑定">绑定状态</span><b>${anchorIsBound(anchor) ? '当前绑定' : '未绑定'}</b></div>
      <div class="basic-stat"><span title="以助手消息收尾则为完整；未以助手答复收尾的保存记录可能以工具结果收尾">对话完整性</span><b title="按现在的保存规则最后一条应是助手答复；这份是更早存的，最后一条不是。不补造 assistant。">${conversationComplete ? '完整（助手答复收尾）' : '未以助手答复收尾'}</b></div>
      <div class="basic-stat"><span title="生成时请求的思考强度配置">推理强度</span><b>${escapeHtml(reasoningEffortLabels[requestSettings.reasoningEffort] ?? requestSettings.reasoningEffort ?? '—')}</b></div>
      <div class="basic-stat"><span title="生成时请求的最大输出 token 上限">最大输出</span><b>${requestSettings.maxTokens != null ? `${formatNumber(requestSettings.maxTokens)} tokens` : '—'}</b></div>
      <div class="basic-stat"><span title="完整消息条数">消息数</span><b>${formatNumber(messages.length)}</b></div>
      <div class="basic-stat"><span title="生成轨迹中的助手轮次">助手轮次</span><b>${formatNumber(assistantTurns.length)}</b></div>
      <div class="basic-stat"><span title="生成轨迹中的工具调用事件数">工具事件</span><b>${formatNumber(toolEvents.length)}</b></div>
    </div>
    <dl class="fact-list">
      <div><dt>指纹</dt><dd><code>${escapeHtml(anchor.fingerprint ?? '—')}</code></dd></div>
      <div><dt>目录路径</dt><dd><code>${escapeHtml(anchor.path ?? '—')}</code></dd></div>
    </dl>
    <p class="subheading">token 统计 ${helpIcon('各字段来自保存时上游返回的用量；未返回的字段显示“—”，不推算。')}</p>
    <div class="basic-stats anchor-token-stats">
      <div class="basic-stat"><span title="保存时上游返回的总 tokens">总 tokens</span><b>${usage.totalTokens != null ? formatNumber(usage.totalTokens) : '—'}</b></div>
      <div class="basic-stat"><span title="本次上游请求的提示 tokens">输入 tokens</span><b>${usage.promptTokens != null ? formatNumber(usage.promptTokens) : '—'}</b></div>
      <div class="basic-stat"><span title="本次上游请求的完成 tokens">输出 tokens</span><b>${usage.completionTokens != null ? formatNumber(usage.completionTokens) : '—'}</b></div>
      <div class="basic-stat"><span title="输出中的推理 tokens">推理 tokens</span><b>${usage.reasoningTokens != null ? formatNumber(usage.reasoningTokens) : '—'}</b></div>
      <div class="basic-stat"><span title="输出中推理之外的正文 tokens，由输出与推理相减得出">正文 tokens</span><b>${contentTokens != null ? formatNumber(contentTokens) : '—'}</b></div>
      <div class="basic-stat"><span title="命中 Provider 缓存的提示 tokens">缓存命中</span><b>${usage.cacheHitTokens != null ? formatNumber(usage.cacheHitTokens) : '—'}</b></div>
      <div class="basic-stat"><span title="未命中缓存的提示 tokens">未缓存输入</span><b>${usage.cacheMissTokens != null ? formatNumber(usage.cacheMissTokens) : '—'}</b></div>
      <div class="basic-stat"><span title="缓存命中 / 提示总 tokens；缺失时不推算">缓存命中率</span><b>${formatPercent(cacheRate)}</b></div>
    </div>
    <p class="subheading">续接指令（continuation）</p>
    ${continuationText
      ? `<div class="continuation-block"><code>${escapeHtml(continuationModeLabels[continuation.mode] ?? continuation.mode ?? '—')}</code><pre class="conversation-content">${escapeHtml(continuationText)}</pre></div>`
      : '<p class="muted">未设置续接指令</p>'}
    <p class="subheading">工具调用状态 ${helpIcon('仅表示生成轨迹中是否完成对应调用，不代表质量判定。')}</p>
    ${renderAnchorToolStatus(anchor)}
    <p class="subheading">完整消息（思维链 / 正文 / 工具调用 / 工具结果）</p>
    ${messages.length
      ? conversationBlocks(messages)
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
  const deleteButton = event.target.closest('[data-delete-anchor-path]')
  if (deleteButton) {
    void deleteAnchorArtifact(
      deleteButton.dataset.deleteAnchorPath ?? '',
      deleteButton.dataset.deleteAnchorId ?? '',
    )
    return
  }
  const button = event.target.closest('[data-view-anchor-path]')
  if (!button) return
  void openAnchorView(button.dataset.viewAnchorPath ?? '', button.dataset.viewAnchorId ?? '')
})

async function deleteAnchorArtifact(path, id) {
  const artifact = (state.anchorCatalog ?? []).find((entry) => (
    (path && entry.path === path) || (!path && id && entry.id === id)
  )) ?? { path, id }
  const name = artifact.displayName ?? artifact.id ?? '未命名'
  if (!window.confirm(`确认删除 Anchor「${name}」？删除后不可恢复。`)) return
  try {
    await fetchJson('/__gateway/anchors', {
      method: 'DELETE',
      body: path ? { path } : { id },
    })
    toast('Anchor 已删除')
    // 全量重绘：catalog 不在 dataFingerprint 里，quiet 刷新不会重画配置表的
    // Anchor 选项；这里 force 一次并把缓存指纹重置，列表与配置表都更新。
    await loadData({ quiet: false, force: true })
  } catch (error) {
    if (error.status === 409) {
      // 服务端明确拒绝：显示具体引用的模型平面，要求先换绑定；不自动解绑。
      const refs = Array.isArray(error.payload?.error?.referencedBy)
        ? error.payload.error.referencedBy
        : []
      toast(refs.length
        ? `无法删除：该 Anchor 正被 ${refs.map(microProfileLabel).join('、')} 使用，请先在这些模型切换到其他 Anchor。`
        : `无法删除：${error.message}`)
      return
    }
    toast(`删除失败：${error.message}`)
  }
}

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
    openSelectDialog(selectButton.dataset.selectCandidate, selectButton.dataset.candidateIndex)
    return
  }
  const activateButton = event.target.closest('[data-activate-job]')
  if (activateButton) {
    void pickJobAction(activateButton, 'activate')
    return
  }
  const discardButton = event.target.closest('[data-discard-job]')
  if (discardButton) void pickJobAction(discardButton, 'discard')
})

function renderAnchorExampleButton() {
  const profileName = elements.anchorProfile.value
  const profile = (state.config?.profiles ?? []).find((item) => item.name === profileName)
  const model = profile?.model
  // 只从 catalog 取该模型的 default；没有则禁用，禁止退回 Pro/control。
  const example = model
    ? state.anchorCatalog.find((artifact) =>
        artifact.model === model &&
        artifact.category === 'default' &&
        artifact.selectable !== false &&
        !artifact.copiedBaseline)
    : null
  elements.anchorExample.disabled = !example
  elements.anchorExample.textContent = example ? '查看该模型示例 Anchor' : '尚无模型原生示例'
  elements.anchorExample.dataset.anchorPath = example?.path ?? ''
  elements.anchorExample.dataset.anchorId = example?.id ?? ''
}

// ---------- D: 微锚点独立管理 UI ----------
// 微锚点是附加到每次第三方历史 user 消息末尾的短文本，是对模型配置里
// 的「增强模式 / Anchor Artifact」之外的独立开关；页面一律不称 continuation。
const MICRO_ANCHOR_CACHE_WARNING =
  '修改微锚内容、切换所选微锚或切换微锚开关会改变当前会话的请求历史，并可能导致 KV Cache 重新计算。Gateway 不会清除 Provider 侧缓存；恢复到此前的微锚点状态后，如果其他请求输入也一致，Provider 仍可能复用此前缓存。'
const MICRO_PROFILE_LABELS = {
  pro: 'Pro',
  flash: 'Flash',
  vision: 'Vision',
  combined: '多模型路由口',
  single: '多模型路由口',
}
const MICRO_ANCHOR_CONTENT_PREVIEW_LIMIT = 160

function microAnchorCacheWarning() {
  return state.microAnchors?.cacheWarning || MICRO_ANCHOR_CACHE_WARNING
}

function microProfileLabel(name) {
  return MICRO_PROFILE_LABELS[name] ?? name ?? '—'
}

function microAnchorProfileTitle(name) {
  const profile = (state.config?.profiles ?? []).find((item) => item.name === name)
  return profile
    ? `${microProfileLabel(name)} · ${profile.model}`
    : microProfileLabel(name)
}

// 与服务端正文规范化一致：仅把 CRLF 统一为 LF（trim/长度由服务端执行，
// 这里只用于判断“字节等价”，不改变比较结果）。
function normalizeMicroAnchorContentForCompare(value) {
  return String(value ?? '').replace(/\r\n/g, '\n')
}

function microAnchorDefinitionById(id) {
  return (state.microAnchors?.definitions ?? []).find((definition) => definition.id === id) ?? null
}

function microAnchorApplyState(name) {
  // 微锚修改走进程内热应用（restartRequired=false 时服务端返回 applied）；
  // 只在服务端明确要求重启时才显示“重启后生效”。
  return state.microAnchorApply[name] ?? 'applied'
}

function microAnchorMutationNote(result) {
  const affected = Array.isArray(result?.affectedProfiles) ? result.affectedProfiles : []
  if (result?.restartRequired) return '已保存，重启后生效。'
  if (!affected.length) return '已保存，未改变任何模型的生效设定。'
  return `已应用：${affected.map(microProfileLabel).join('、')}。`
}

function applyMicroAnchorMutation(result) {
  const view = result?.documentView?.microAnchors ?? result?.microAnchors
  if (view) state.microAnchors = view
  // PATCH profile 响应带独立的 profile 视图（含 running 等实时字段），
  // merge 回现有列表以免丢失运行状态。
  if (result?.profile && Array.isArray(state.config?.profiles)) {
    state.config = {
      ...(state.config ?? {}),
      profiles: state.config.profiles.map((item) => (
        item.name === result.profile.name ? { ...item, ...result.profile } : item
      )),
    }
  }
  state.microAnchorApply = {}
  for (const name of Array.isArray(result?.affectedProfiles) ? result.affectedProfiles : []) {
    state.microAnchorApply[name] = result.restartRequired ? 'pending' : 'applied'
  }
  const note = microAnchorMutationNote(result)
  elements.microAnchorApplyNote.textContent = note
  elements.microAnchorApplyNote.hidden = false
  renderMicroAnchors()
}

function renderMicroAnchorReferencedBy(definition) {
  const refs = Array.isArray(definition.referencedBy) ? definition.referencedBy : []
  if (!refs.length) return '<span class="muted">未被引用</span>'
  return `被引用：<b>${refs.map(microProfileLabel).join('、')}</b>`
}

function microAnchorContentPreview(content) {
  const text = String(content ?? '')
  return text.length > MICRO_ANCHOR_CONTENT_PREVIEW_LIMIT
    ? `${text.slice(0, MICRO_ANCHOR_CONTENT_PREVIEW_LIMIT)}…`
    : text
}

function renderMicroAnchorDefinitionCard(definition) {
  const builtin = definition.source === 'builtin' || definition.readonly
  const refs = renderMicroAnchorReferencedBy(definition)
  const fingerprint = definition.contentFingerprint
    ? `<code class="micro-anchor-fingerprint" title="${escapeHtml(definition.contentFingerprint)}">SHA-256 ${escapeHtml(shortId(definition.contentFingerprint, 20))}</code>`
    : '<code class="micro-anchor-fingerprint muted">SHA-256 —</code>'
  if (builtin) {
    // 默认卡：锁定/内置徽标、完整只读正文、内容指纹、引用模型、“复制为自定义”。
    return `
      <div class="micro-anchor-card builtin">
        <div class="micro-anchor-card-head">
          <strong>${escapeHtml(definition.name)}</strong>
          <span class="anchor-badges">
            <span class="anchor-badge default" title="内置默认微锚点，不可编辑或删除">内置 · 锁定</span>
          </span>
        </div>
        <pre class="micro-anchor-content">${escapeHtml(definition.content)}</pre>
        <div class="micro-anchor-card-meta">
          ${fingerprint}
          <span>${refs}</span>
        </div>
        <div class="micro-anchor-card-actions">
          <button class="button ghost" type="button" data-micro-anchor-copy="${escapeHtml(definition.id)}">复制为自定义</button>
        </div>
      </div>`
  }
  const preview = microAnchorContentPreview(definition.content)
  const truncated = String(definition.content ?? '').length > MICRO_ANCHOR_CONTENT_PREVIEW_LIMIT
  return `
    <div class="micro-anchor-card">
      <div class="micro-anchor-card-head">
        <strong>${escapeHtml(definition.name)}</strong>
        <span class="anchor-badges">
          <span class="anchor-badge generated" title="用户创建或从默认项复制，可编辑删除">自定义</span>
        </span>
      </div>
      <pre class="micro-anchor-preview">${escapeHtml(preview)}${truncated ? '<span class="micro-anchor-preview-more">（已截断，点“只读查看”看完整正文）</span>' : ''}</pre>
      <div class="micro-anchor-card-meta">
        ${fingerprint}
        <span>${refs}</span>
      </div>
      <div class="micro-anchor-card-actions">
        <button class="button ghost" type="button" data-micro-anchor-view="${escapeHtml(definition.id)}">只读查看</button>
        <button class="button ghost" type="button" data-micro-anchor-edit="${escapeHtml(definition.id)}">编辑</button>
        <button class="button danger" type="button" data-micro-anchor-delete="${escapeHtml(definition.id)}">删除</button>
      </div>
    </div>`
}

function renderMicroAnchorDefinitions() {
  const definitions = Array.isArray(state.microAnchors?.definitions)
    ? state.microAnchors.definitions
    : []
  if (!definitions.length) {
    elements.microAnchorDefinitions.innerHTML =
      '<p class="muted">当前没有微锚点；默认项会在 Gateway 可用后返回。</p>'
    return
  }
  elements.microAnchorDefinitions.innerHTML = definitions
    .map(renderMicroAnchorDefinitionCard)
    .join('')
}

function renderMicroAnchorProfiles() {
  const profiles = state.microAnchors?.profiles ?? {}
  const names = ['pro', 'flash', 'vision'].filter((name) => profiles[name])
  if (!names.length) {
    elements.microAnchorProfiles.innerHTML = '<p class="muted">当前服务未提供微锚点模型配置。</p>'
    return
  }
  const definitions = Array.isArray(state.microAnchors?.definitions)
    ? state.microAnchors.definitions
    : []
  elements.microAnchorProfiles.innerHTML = names.map((name) => {
    const selection = profiles[name] ?? {}
    const apply = microAnchorApplyState(name)
    const options = definitions.map((definition) => `
      <option value="${escapeHtml(definition.id)}" ${definition.id === selection.selectedId ? 'selected' : ''}>
        ${escapeHtml(definition.name)}${definition.source === 'builtin' ? ' · 内置' : ''}
      </option>`).join('')
    return `
      <form class="micro-anchor-profile" data-micro-anchor-profile="${escapeHtml(name)}">
        <div class="micro-anchor-profile-head">
          <strong>${escapeHtml(microAnchorProfileTitle(name))}</strong>
          <span class="micro-anchor-state ${apply}">${apply === 'pending' ? '重启后生效' : '已应用'}</span>
        </div>
        <label class="toggle-field wide">
          <input name="enabled" type="checkbox" ${selection.enabled ? 'checked' : ''}>
          <span>启用微锚点</span>
        </label>
        <label>
          <span>保存项${helpIcon('每个模型选择要使用的微锚点定义；关闭开关时不注入任何微锚点文本。')}</span>
          <select name="selectedId">${options}</select>
        </label>
        <div class="micro-anchor-effective">
          <span>生效指纹${helpIcon('启用时是指将追加到该模型每条第三方 user 消息的正文指纹；关闭时无生效文本。')}</span>
          <code class="${selection.enabled && selection.effectiveFingerprint ? '' : 'muted'}" title="${escapeHtml(selection.effectiveFingerprint ?? '')}">${selection.enabled && selection.effectiveFingerprint ? escapeHtml(shortId(selection.effectiveFingerprint, 16)) : '未启用'}</code>
        </div>
        <button class="button secondary" type="submit">保存应用</button>
      </form>`
  }).join('')
}

function renderMicroAnchors() {
  const warning = microAnchorCacheWarning()
  if (elements.microAnchorWarning.textContent !== warning) {
    elements.microAnchorWarning.textContent = warning
  }
  renderMicroAnchorDefinitions()
  renderMicroAnchorProfiles()
}

function openMicroAnchorView(id) {
  const definition = microAnchorDefinitionById(id)
  if (!definition) {
    toast('找不到该微锚点')
    return
  }
  elements.microAnchorViewTitle.textContent = `微锚点 · ${definition.name}`
  elements.microAnchorViewBody.innerHTML = `
    <dl class="fact-list">
      <div><dt>名称</dt><dd>${escapeHtml(definition.name)}</dd></div>
      <div><dt>来源</dt><dd>${definition.source === 'builtin' ? '内置默认（只读）' : '自定义'}</dd></div>
      <div><dt>内容指纹</dt><dd><code>${escapeHtml(definition.contentFingerprint ?? '—')}</code></dd></div>
      <div><dt>引用</dt><dd>${escapeHtml((definition.referencedBy ?? []).map(microProfileLabel).join('、') || '—')}</dd></div>
    </dl>
    <p class="subheading">完整正文</p>
    <pre class="micro-anchor-content">${escapeHtml(definition.content)}</pre>`
  elements.microAnchorViewDialog.showModal()
}

function microAnchorDialogModeTitle(mode) {
  if (mode === 'edit') return '编辑微锚点'
  if (mode === 'copy') return '复制默认微锚点'
  return '新建微锚点'
}

function openMicroAnchorDialog(mode, id = null) {
  if (elements.microAnchorDialog.open) return
  const definition = id ? microAnchorDefinitionById(id) : null
  state.microAnchorDialogState = { mode, id: definition?.id ?? null }
  elements.microAnchorDialogTitle.textContent = microAnchorDialogModeTitle(mode)
  elements.microAnchorDialogError.hidden = true
  elements.microAnchorDialogError.textContent = ''
  elements.microAnchorDialogSubmit.disabled = false
  elements.microAnchorName.value = mode === 'edit' ? (definition?.name ?? '') : ''
  elements.microAnchorContent.value = mode === 'edit' ? (definition?.content ?? '') : ''
  if (mode === 'edit' && definition) {
    const refs = Array.isArray(definition.referencedBy) ? definition.referencedBy : []
    const enabledRefs = refs.filter((name) => state.microAnchors?.profiles?.[name]?.enabled)
    elements.microAnchorDialogNote.textContent = enabledRefs.length
      ? `正文将写入该定义；当前正被 ${enabledRefs.map(microProfileLabel).join('、')} 使用，保存后这些模型将使用新正文。`
      : '编辑只改动定义本身；当前没有启用它的模型，保存后不影响任何请求历史。'
  } else if (mode === 'copy') {
    elements.microAnchorDialogNote.textContent =
      '正文将由服务端从默认微锚点读取并保存，页面不提交正文副本（正文以默认项为准）。'
  } else {
    elements.microAnchorDialogNote.textContent =
      '名称 1–80 字符且全局唯一；正文最多 4000 字符，保存后可用于任意模型。'
  }
  elements.microAnchorContentField.hidden = mode === 'copy'
  elements.microAnchorDialog.showModal()
  elements.microAnchorName.focus()
}

async function deleteMicroAnchor(id) {
  const definition = microAnchorDefinitionById(id)
  if (!definition) return
  if (!window.confirm(`确认删除微锚点「${definition.name}」？删除后不可恢复。`)) return
  try {
    const result = await fetchJson(
      `/__gateway/micro-anchors/${encodeURIComponent(id)}`,
      { method: 'DELETE', body: {} },
    )
    applyMicroAnchorMutation(result)
    toast('微锚点已删除')
  } catch (error) {
    if (error.status === 409) {
      // 服务端明确拒绝：显示具体引用模型，要求先切换；不自动回落默认。
      const refs = Array.isArray(error.payload?.error?.referencedBy)
        ? error.payload.error.referencedBy
        : []
      toast(refs.length
        ? `无法删除：该微锚点正被 ${refs.map(microProfileLabel).join('、')} 使用，请先在这些模型切换到其他保存项。`
        : `无法删除：${error.message}`)
      return
    }
    toast(`删除失败：${error.message}`)
  }
}

async function saveMicroAnchorProfile(form) {
  const name = form.dataset.microAnchorProfile
  const selection = state.microAnchors?.profiles?.[name] ?? {}
  const enabled = form.querySelector('input[name="enabled"]').checked
  const selectedId = form.querySelector('select[name="selectedId"]').value
  if (enabled === Boolean(selection.enabled) && selectedId === selection.selectedId) return
  const nextDefinition = microAnchorDefinitionById(selectedId)
  // “有效文本”比较：只需判断启用时的正文指纹是否变化；相同指纹（含字节
  // 等价的另一保存项、或开关前后都未启用）不误报缓存失效。
  const oldFingerprint = selection.enabled ? selection.effectiveFingerprint ?? null : null
  const nextFingerprint = enabled ? nextDefinition?.contentFingerprint ?? null : null
  if (oldFingerprint !== nextFingerprint) {
    const ok = window.confirm(
      `${microAnchorCacheWarning()}\n\n将更新 ${microProfileLabel(name)} 的微锚点设置。确定继续吗？`,
    )
    if (!ok) return
  }
  const submit = form.querySelector('button[type="submit"]')
  submit.disabled = true
  try {
    const result = await fetchJson(
      `/__gateway/config/profiles/${encodeURIComponent(name)}`,
      {
        method: 'PATCH',
        body: { microAnchor: { enabled: Boolean(enabled), selectedId } },
      },
    )
    applyMicroAnchorMutation(result)
    toast(result.restartRequired
      ? `${microProfileLabel(name)} 微锚点已保存，重启后生效`
      : `${microProfileLabel(name)} 微锚点已保存并应用`)
  } catch (error) {
    toast(`${microProfileLabel(name)} 微锚点保存失败：${error.message}`)
    submit.disabled = false
  }
}

function renderAnchorControls() {
  const profiles = state.config?.profiles ?? []
  const previous = elements.anchorProfile.value
  // 缺 Key 的项 disabled 并标注；若没有可选配置，加占位项避免空白 select。
  const selectable = profiles.filter((profile) => profile.apiKeyConfigured)
  const options = profiles.map((profile) => `
    <option value="${escapeHtml(profile.name)}" ${!profile.apiKeyConfigured ? 'disabled' : ''}>
      ${escapeHtml(profile.name.toUpperCase())} · ${escapeHtml(profile.model)}${!profile.apiKeyConfigured ? '（缺少 Key）' : !profile.enabled ? '（未启用，可先生成）' : ''}
    </option>`).join('')
  elements.anchorProfile.innerHTML = `${selectable.length
    ? ''
    : '<option value="" disabled selected>无可选生成目标（目标模型缺少 Key）</option>'}${options}`
  if (profiles.some((profile) => profile.name === previous && profile.apiKeyConfigured)) {
    elements.anchorProfile.value = previous
  }
  const submit = elements.anchorForm.querySelector('button[type="submit"]')
  submit.disabled = !elements.anchorProfile.value || state.jobs.some((job) =>
    ['queued', 'running'].includes(job.status) && job.profile === elements.anchorProfile.value)
  renderAnchorExampleButton()
  renderAnchorJobs()
}

elements.anchorExample.addEventListener('click', () => {
  const path = elements.anchorExample.dataset.anchorPath
  const id = elements.anchorExample.dataset.anchorId
  if (!path && !id) {
    toast('当前模型没有原生示例 Anchor')
    return
  }
  void openAnchorView(path, id)
})

// ---------- D: 微锚点管理交互 ----------
elements.microAnchorCreate.addEventListener('click', () => openMicroAnchorDialog('create'))

elements.microAnchorDefinitions.addEventListener('click', (event) => {
  const button = event.target.closest('[data-micro-anchor-copy], [data-micro-anchor-edit], [data-micro-anchor-delete], [data-micro-anchor-view]')
  if (!button) return
  if (button.dataset.microAnchorCopy) {
    openMicroAnchorDialog('copy', button.dataset.microAnchorCopy)
    return
  }
  if (button.dataset.microAnchorEdit) {
    openMicroAnchorDialog('edit', button.dataset.microAnchorEdit)
    return
  }
  if (button.dataset.microAnchorDelete) {
    void deleteMicroAnchor(button.dataset.microAnchorDelete)
    return
  }
  if (button.dataset.microAnchorView) {
    openMicroAnchorView(button.dataset.microAnchorView)
  }
})

elements.microAnchorProfiles.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-micro-anchor-profile]')
  if (!form) return
  event.preventDefault()
  void saveMicroAnchorProfile(form)
})

elements.microAnchorDialogClose.addEventListener('click', () => {
  elements.microAnchorDialog.close()
  state.microAnchorDialogState = null
})
elements.microAnchorDialogCancel.addEventListener('click', () => {
  elements.microAnchorDialog.close()
  state.microAnchorDialogState = null
})

elements.microAnchorForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const dialogState = state.microAnchorDialogState
  if (!dialogState) return
  elements.microAnchorDialogError.hidden = true
  elements.microAnchorDialogError.textContent = ''
  const name = elements.microAnchorName.value.trim()
  if (name.length < 1 || name.length > 80) {
    elements.microAnchorDialogError.textContent = '名称必须为 1–80 个字符（首尾空白会被忽略）。'
    elements.microAnchorDialogError.hidden = false
    return
  }
  const submit = elements.microAnchorDialogSubmit
  submit.disabled = true
  try {
    if (dialogState.mode === 'edit') {
      const definition = microAnchorDefinitionById(dialogState.id)
      const content = elements.microAnchorContent.value
      if (content.trim() === '') {
        elements.microAnchorDialogError.textContent = '正文不能为空（首尾空白会被忽略）。'
        elements.microAnchorDialogError.hidden = false
        submit.disabled = false
        return
      }
      // 编辑正在使用的自定义项：若启用该定义的模型会看到不同有效文本，
      // 保存前显示统一缓存警告；正文字节等价时不误报。
      const refs = Array.isArray(definition?.referencedBy) ? definition.referencedBy : []
      const enabledRefs = refs.filter((profileName) =>
        state.microAnchors?.profiles?.[profileName]?.enabled)
      const bytesChanged = normalizeMicroAnchorContentForCompare(content) !==
        normalizeMicroAnchorContentForCompare(definition?.content)
      if (enabledRefs.length > 0 && bytesChanged) {
        const ok = window.confirm(
          `${microAnchorCacheWarning()}\n\n将更新正被 ${enabledRefs.map(microProfileLabel).join('、')} 使用的微锚点。确定继续吗？`,
        )
        if (!ok) {
          submit.disabled = false
          return
        }
      }
      const result = await fetchJson(
        `/__gateway/micro-anchors/${encodeURIComponent(dialogState.id)}`,
        { method: 'PATCH', body: { name, content } },
      )
      applyMicroAnchorMutation(result)
      toast('微锚点已保存')
    } else {
      const body = dialogState.mode === 'copy'
        ? { name, copyFromId: dialogState.id }
        : { name, content: elements.microAnchorContent.value }
      if (dialogState.mode !== 'copy' && String(body.content ?? '').trim() === '') {
        elements.microAnchorDialogError.textContent = '正文不能为空（首尾空白会被忽略）。'
        elements.microAnchorDialogError.hidden = false
        submit.disabled = false
        return
      }
      const result = await fetchJson('/__gateway/micro-anchors', {
        method: 'POST',
        body,
      })
      applyMicroAnchorMutation(result)
      toast(dialogState.mode === 'copy' ? '已复制为自定义微锚点' : '微锚点已创建')
    }
    elements.microAnchorDialog.close()
    state.microAnchorDialogState = null
  } catch (error) {
    if (error.status === 409 || error.status === 400) {
      elements.microAnchorDialogError.textContent = error.message
      elements.microAnchorDialogError.hidden = false
    } else {
      toast(`保存失败：${error.message}`)
    }
    submit.disabled = false
  }
})

elements.microAnchorViewClose.addEventListener('click', () => {
  elements.microAnchorViewDialog.close()
})

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
        <div><dt>${escapeHtml(instance.profile)} Key</dt><dd>${instance.gatewayApiKeyConfigured ? `已配置 · ${escapeHtml(instance.gatewayApiKeyPreview ?? '已配置')}` : '未配置 · 该端口不可用'}</dd></div>
      `).join('')}
      <div><dt>凭据策略</dt><dd>${escapeHtml(health.credentialPolicy ?? 'gateway-only')}</dd></div>
      <div><dt>版本</dt><dd>v${escapeHtml(health.version ?? '—')}</dd></div>`
    return
  }
  const planes = Array.isArray(health.planes) ? health.planes : []
  const planeFacts = planes.length
    ? planes.map((plane) => `
        <div><dt>${escapeHtml(plane.name || plane.model)} 上游</dt><dd>${escapeHtml(plane.upstreamBaseUrl ?? '—')}</dd></div>
        <div><dt>${escapeHtml(plane.name || plane.model)} Key</dt><dd>${plane.gatewayApiKeyConfigured ? '已配置' : '未配置'}</dd></div>`).join('')
    : `
        <div><dt>上游地址</dt><dd>${escapeHtml(health.upstreamBaseUrl ?? '—')}</dd></div>
        <div><dt>Gateway Key</dt><dd>${health.gatewayApiKeyConfigured ? '已配置' : '未配置 · 数据面不可用'}</dd></div>`
  elements.configList.innerHTML = `
    ${planeFacts}
    <div><dt>采集模式</dt><dd>${escapeHtml(health.captureMode)}</dd></div>
    <div><dt>管理鉴权</dt><dd>${health.managementAuthRequired ? '已启用' : '仅本机免令牌'}</dd></div>
    <div><dt>凭据策略</dt><dd>${escapeHtml(health.credentialPolicy ?? 'gateway-only')}</dd></div>
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
  renderMicroAnchors()
  renderDeployment()
  renderProfiles()
  renderAnchorControls()
  renderConfig()
}

// A: 编辑焦点所在的表单容器；焦点在其中时绝不重建对应表格。
const mutableFormSelector =
  '#profile-list, #deployment-form, .micro-anchor-profiles, .micro-anchor-definitions'

function focusInMutableForms() {
  const active = document.activeElement
  if (!active || typeof active.closest !== 'function') return false
  return Boolean(active.closest(mutableFormSelector))
}

function dataFingerprint() {
  return JSON.stringify({
    deployment: state.config?.deployment ?? null,
    profiles: state.config?.profiles ?? null,
    microAnchors: state.microAnchors ?? null,
    deploymentMode: state.health?.deploymentMode ?? null,
  })
}

// A: quiet 刷新下仅在数据指纹变化且焦点不在这些表单内时重绘；
// 焦点被占用时指纹不提交，用户离开表单后的下一次 tick 会补上。
function renderMutablePanelsIfChanged() {
  const fingerprint = dataFingerprint()
  if (fingerprint === state.configFingerprint) return
  if (focusInMutableForms()) return
  state.configFingerprint = fingerprint
  renderProfiles()
  renderDeployment()
  renderMicroAnchors()
  renderConfig()
}

// A: 自动轮询 / visibilitychange 的 quiet 刷新只更新展示面板与 jobs；
// 模型独立配置等可编辑面板走 renderMutablePanelsIfChanged 条件重绘。
function renderQuiet() {
  renderMetrics()
  renderRows()
  renderDetail()
  renderAnchors()
  renderAnchorJobs()
  renderMutablePanelsIfChanged()
}

async function loadData({ quiet = false, force = false } = {}) {
  if (state.loading && !force) return
  const epoch = ++loadEpoch
  state.loading = true
  if (!quiet) setConnection('waiting', '正在连接')
  elements.refreshButton.disabled = true
  try {
    const [health, diagnostics, config, jobs, anchorCatalog, microAnchors] = await Promise.all([
      fetchJson('/__gateway/health'),
      fetchJson('/__gateway/diagnostics?limit=500'),
      fetchOptionalJson('/__gateway/config', { profiles: [] }),
      fetchOptionalJson('/__gateway/anchors/jobs', { jobs: [] }),
      fetchOptionalJson('/__gateway/anchors', { anchors: [] }),
      fetchOptionalJson('/__gateway/micro-anchors', { cacheWarning: '', definitions: [], profiles: {} }),
    ])
    if (epoch !== loadEpoch) return
    state.health = health
    state.config = config
    state.jobs = Array.isArray(jobs.jobs) ? jobs.jobs : []
    state.anchorCatalog = Array.isArray(anchorCatalog.anchors) ? anchorCatalog.anchors : []
    state.microAnchors = microAnchors.microAnchors ?? microAnchors
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
    if (force || !quiet) {
      // 手动刷新 / 保存成功 / force：完整重绘，可编辑面板无条件刷新。
      renderAll()
      state.configFingerprint = dataFingerprint()
    } else {
      renderQuiet()
    }
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

async function probeProfile(button) {
  const name = button.dataset.probeProfile
  const resultEl = button.closest('form')?.querySelector('[data-probe-result]')
  const original = button.textContent
  button.disabled = true
  button.textContent = '正在请求回复…'
  if (resultEl) {
    resultEl.hidden = false
    resultEl.className = 'probe-result pending'
    resultEl.textContent = '正在向上游发送「你好」…'
  }
  try {
    const result = await fetchJson(
      `/__gateway/config/profiles/${encodeURIComponent(name)}/probe`,
      { method: 'POST', body: {} },
    )
    if (result.ok) {
      toast(`${name.toUpperCase()} 已回复（${result.latencyMs}ms）`)
      if (resultEl) {
        resultEl.className = 'probe-result ok'
        resultEl.textContent = `回复：${result.reply || '（空）'} · ${result.latencyMs}ms · ${result.upstreamModel || result.model}`
      }
      return
    }
    toast(`${name.toUpperCase()} 测试失败：${result.error}`)
    if (resultEl) {
      resultEl.className = 'probe-result error'
      resultEl.textContent = result.error || '测试失败'
    }
  } catch (error) {
    toast(`${name.toUpperCase()} 测试失败：${error.message}`)
    if (resultEl) {
      resultEl.className = 'probe-result error'
      resultEl.textContent = error.message
    }
  } finally {
    button.disabled = false
    button.textContent = original
  }
}

elements.profileList.addEventListener('click', (event) => {
  const probeButton = event.target.closest('[data-probe-profile]')
  if (probeButton) {
    event.preventDefault()
    void probeProfile(probeButton)
    return
  }
  const button = event.target.closest('[data-copy-id]')
  if (button) copyText(button.dataset.copyId, 'Harness 模型名已复制')
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
    upstreamModel: String(data.get('upstreamModel') ?? '').trim(),
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
    // 保存成功走完整重绘：新配置必须立即落进表单与配置面板。
    await loadData({ quiet: true, force: true })
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
  // 原样提交：空 textarea 传显式空字符串（""），不 omit；后端对 undefined
  // 才回退中性默认句。
  const continuationMessage = elements.anchorContinuation.value
  const reasoningEffort = elements.anchorReasoningEffort.value
  const maximumCalls = runs * maxSubturns
  const pending = state.jobs.find((job) =>
    job.profile === profile && job.status === 'awaiting-selection')
  const pendingNote = pending
    ? `\n\n该模型上一轮还有 ${pending.candidates?.length ?? 0} 个待选候选，开始后会自动放弃。`
    : ''
  if (!window.confirm(`将为 ${profile.toUpperCase()} 生成专属 Anchor，最多发起 ${maximumCalls} 次计费上游请求。${pendingNote}继续吗？`)) return
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
elements.inputFilter.addEventListener('change', renderRows)
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
  if (!state.jobs.some((job) => ['queued', 'running', 'reserving-name', 'freezing'].includes(job.status))) return
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
