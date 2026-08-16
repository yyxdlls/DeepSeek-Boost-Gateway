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
  detailPanel: $('detail-panel'),
  anchorList: $('anchor-list'),
  anchorJobs: $('anchor-jobs'),
  anchorForm: $('anchor-form'),
  anchorProfile: $('anchor-profile'),
  anchorRuns: $('anchor-runs'),
  anchorSubturns: $('anchor-subturns'),
  anchorMaxTokens: $('anchor-max-tokens'),
  anchorCostNote: $('anchor-cost-note'),
  profileList: $('profile-list'),
  configList: $('config-list'),
  lastUpdated: $('last-updated'),
  tokenDialog: $('token-dialog'),
  tokenInput: $('token-input'),
  clearToken: $('clear-token'),
  saveToken: $('save-token'),
  toast: $('toast'),
}

const state = {
  health: null,
  entries: [],
  markerProfile: null,
  config: null,
  jobs: [],
  selectedId: null,
  loading: false,
  token: sessionStorage.getItem('gateway-management-token') ?? '',
}

let toastTimer

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
    (sum, entry) => sum + Number(entry.response?.summary?.reasoning?.markers?.letMe ?? 0),
    0,
  )
  $('metric-mode').textContent = health?.mode ?? '—'
  $('metric-mode-note').textContent = health
    ? !health.gatewayApiKeyConfigured
      ? '数据面等待 Gateway Key'
      : health.deploymentMode === 'split'
        ? `${instances.length} 个独立数据端口`
        : health.mode === 'anchor' ? 'Chat Completions 默认增强' : '默认透明旁路'
    : '等待 Gateway'
  $('metric-anchors').textContent = health ? formatNumber(health.anchors?.length ?? 0) : '—'
  $('metric-anchor-note').textContent = health?.anchors?.length
    ? health.anchors.map((anchor) => anchor.model).join(' · ')
    : '模型严格隔离'
  $('metric-retained').textContent = state.health ? formatNumber(state.entries.length) : '—'
  $('metric-retained-note').textContent = health
    ? `上限 ${formatNumber(health.diagnosticHistoryLimit)}`
    : '内存诊断记录'
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
}

function renderRows() {
  const entries = filteredEntries()
  elements.requestRows.innerHTML = entries.map((entry) => {
    const status = requestState(entry)
    const summary = entry.response?.summary
    const tools = currentToolNames(entry)
    const modeClass = String(entry.mode ?? '').startsWith('anchor') ? 'anchor' : ''
    return `
      <tr data-request-id="${escapeHtml(entry.requestId)}" tabindex="0" class="${entry.requestId === state.selectedId ? 'selected' : ''}" aria-label="查看请求 ${escapeHtml(entry.requestId)}">
        <td>
          <span class="cell-primary">${escapeHtml(formatTime(entry.startedAt))}</span>
          <span class="cell-secondary">${escapeHtml(entry.request?.model ?? shortId(entry.requestId))}${entry.profile ? ` · ${escapeHtml(entry.profile)}` : ''}</span>
        </td>
        <td><span class="status-label ${status}">${stateLabels[status]}</span></td>
        <td><span class="mode-label ${modeClass}">${escapeHtml(entry.mode ?? '—')}</span></td>
        <td>
          <span class="cell-primary">${formatNumber(summary?.reasoning?.chars ?? summary?.reasoningChars)}</span>
          <span class="cell-secondary">${escapeHtml(summary?.reasoning?.openingStyle ?? '—')}</span>
        </td>
        <td>${tools.length ? renderTools(tools) : '<span class="muted">无</span>'}</td>
      </tr>`
  }).join('')

  elements.requestEmpty.hidden = entries.length > 0
  elements.requestCount.textContent = state.entries.length
    ? `显示 ${entries.length} 条，共保留 ${state.entries.length} 条 · 详情仅包含统计，不包含提示或回复原文`
    : '诊断记录保存在 Gateway 内存中；服务重启后会清空'
}

function markerLabel(id) {
  return state.markerProfile?.markers?.find((marker) => marker.id === id)?.label ?? id
}

function renderMarkers(markers) {
  if (!markers) return '<p class="muted">没有轨迹关键字统计</p>'
  const profileIds = state.markerProfile?.markers?.map((marker) => marker.id) ?? []
  const ids = [...new Set([...profileIds, ...Object.keys(markers)])]
  ids.sort((left, right) => Number(markers[right] ?? 0) - Number(markers[left] ?? 0))
  return `<div class="marker-grid">${ids.map((id) => {
    const count = Number(markers[id] ?? 0)
    return `<span class="marker-chip ${count ? 'hit' : 'zero'}">${escapeHtml(markerLabel(id))}<b>${formatNumber(count)}</b></span>`
  }).join('')}</div>`
}

function trajectoryBadge(trajectory) {
  if (!trajectory?.label) return '<span class="trajectory-label">未分类</span>'
  return `<span class="trajectory-label">${escapeHtml(trajectory.label)} · ${formatNumber(trajectory.score)}</span>`
}

function summaryBlock(title, scope, summary, note = '') {
  if (!summary) {
    return `<section class="detail-block"><div class="detail-block-heading"><h3>${escapeHtml(title)}</h3><span class="scope-badge">${escapeHtml(scope)}</span></div><p class="muted">${escapeHtml(note || '没有可用统计')}</p></section>`
  }
  const reasoning = summary.reasoning ?? {}
  const content = summary.content ?? {}
  return `
    <section class="detail-block">
      <div class="detail-block-heading">
        <h3>${escapeHtml(title)}</h3>
        <span class="scope-badge">${escapeHtml(scope)}</span>
      </div>
      ${note ? `<p class="muted">${escapeHtml(note)}</p>` : ''}
      <div class="mini-metrics">
        <div class="mini-metric"><span>推理字符</span><strong>${formatNumber(reasoning.chars ?? summary.reasoningChars)}</strong></div>
        <div class="mini-metric"><span>UTF-8 字节</span><strong>${formatNumber(reasoning.utf8Bytes)}</strong></div>
        <div class="mini-metric"><span>正文字符</span><strong>${formatNumber(content.chars ?? summary.contentChars)}</strong></div>
        <div class="mini-metric"><span>开头样式</span><strong title="${escapeHtml(reasoning.openingStyle ?? '—')}">${escapeHtml(reasoning.openingStyle ?? '—')}</strong></div>
        <div class="mini-metric"><span>推理块</span><strong>${formatNumber(reasoning.nonEmptyBlocks ?? reasoning.blocks)}</strong></div>
        <div class="mini-metric"><span>轨迹分类</span><strong>${escapeHtml(reasoning.trajectory?.label ?? '—')}</strong></div>
      </div>
      <p class="subheading">关键字命中</p>
      ${renderMarkers(reasoning.markers)}
      <p class="subheading">工具调用序列</p>
      ${renderTools(summary.tools?.names ?? summary.toolNames ?? [])}
    </section>`
}

function renderDetail() {
  const entry = state.entries.find((item) => item.requestId === state.selectedId)
  if (!entry) {
    elements.detailPanel.innerHTML = `
      <div class="detail-placeholder">
        <span aria-hidden="true">↳</span>
        <h2>选择一次请求</h2>
        <p>这里会拆开显示本次回复、原会话历史和 Anchor 历史，避免把三者混在一起判断。</p>
      </div>`
    return
  }

  const status = requestState(entry)
  const responseSummary = entry.response?.summary
  const anchorHistory = entry.transformation?.anchorHistory
  const requestHistory = entry.request?.history
  const usage = responseSummary?.usage
  const usageRows = usage && typeof usage === 'object'
    ? Object.entries(usage).map(([name, value]) => `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(typeof value === 'object' ? JSON.stringify(value) : value)}</dd></div>`).join('')
    : '<div><dt>Token usage</dt><dd>上游未返回</dd></div>'

  elements.detailPanel.innerHTML = `
    <div class="detail-header">
      <div class="detail-title-row">
        <div>
          <p class="section-kicker">REQUEST DETAIL</p>
          <h2>${escapeHtml(entry.request?.model ?? '未知模型')}</h2>
        </div>
        ${trajectoryBadge(responseSummary?.reasoning?.trajectory)}
      </div>
      <button class="request-id-button" type="button" data-copy-id="${escapeHtml(entry.requestId)}" title="复制完整请求 ID">
        <span>请求</span><code>${escapeHtml(entry.requestId)}</code><b>复制</b>
      </button>
      <div class="detail-statuses">
        <span class="status-label ${status}">${stateLabels[status]}</span>
        ${entry.profile ? `<span class="mode-label">${escapeHtml(entry.profile)}</span>` : ''}
        <span class="mode-label ${String(entry.mode ?? '').startsWith('anchor') ? 'anchor' : ''}">${escapeHtml(entry.mode ?? '—')}</span>
        <span class="mode-label">${escapeHtml(formatDuration(entry.durationMs))}</span>
      </div>
    </div>
    ${summaryBlock('本次回复', 'current_response', responseSummary, '只统计这一次上游新生成的内容。')}
    ${summaryBlock('Anchor 历史', 'anchor_history', anchorHistory, entry.transformation
      ? `Anchor ${entry.transformation.anchorId ?? '—'} · 注入 ${formatNumber(entry.transformation.anchorMessageChars)} 字符`
      : '本次请求没有注入 Anchor。')}
    ${summaryBlock('Harness 原会话', 'request_history', requestHistory, '注入前，Harness 已经携带的 assistant 历史。')}
    <section class="detail-block">
      <div class="detail-block-heading"><h3>传输与用量</h3><span class="scope-badge">transport</span></div>
      <dl class="fact-list">
        <div><dt>开始时间</dt><dd>${escapeHtml(formatTime(entry.startedAt, true))}</dd></div>
        <div><dt>HTTP 状态</dt><dd>${escapeHtml(entry.response?.status ?? '—')}</dd></div>
        <div><dt>Finish reason</dt><dd>${escapeHtml(responseSummary?.finishReasons?.join(', ') || '—')}</dd></div>
        <div><dt>客户端断流</dt><dd>${entry.response?.abortedByClient ? '是' : '否'}</dd></div>
        <div><dt>观测完整</dt><dd>${responseSummary?.observationComplete === false ? '否' : responseSummary ? '是' : '—'}</dd></div>
        <div><dt>错误</dt><dd>${escapeHtml(entry.response?.transportError ?? entry.response?.error ?? '无')}</dd></div>
        ${usageRows}
      </dl>
    </section>`
}

function renderAnchors() {
  const anchors = state.health?.anchors ?? []
  if (!anchors.length) {
    elements.anchorList.innerHTML = '<p class="muted">当前没有加载 Anchor；Anchor 模式将无法服务模型请求。</p>'
    return
  }
  elements.anchorList.innerHTML = anchors.map((anchor) => `
    <div class="anchor-card">
      <div><strong>${escapeHtml(anchor.model)}</strong><small>${escapeHtml(anchor.id ?? '未命名')}</small></div>
      <div><code title="${escapeHtml(anchor.fingerprint ?? '')}">SHA-256 ${escapeHtml(shortId(anchor.fingerprint, 20))}</code><code title="${escapeHtml(anchor.path ?? '')}">${escapeHtml(anchor.path ?? '路径不可用')}</code></div>
    </div>`).join('')
}

function renderProfiles() {
  const profiles = state.config?.profiles ?? state.health?.managedProfiles ?? []
  if (!profiles.length) {
    elements.profileList.innerHTML = '<p class="muted">当前服务不是可管理的 split 模式。请用一键脚本启动默认的管理/数据分离部署。</p>'
    return
  }
  elements.profileList.innerHTML = profiles.map((profile) => `
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
          <label class="wide"><span>Gateway API Key</span><input name="apiKey" type="password" value="" placeholder="${profile.apiKeyConfigured ? profile.apiKeySource === 'shared-fallback' ? '当前继承共享 Key；输入后改为独立 Key' : '已独立配置；留空保持不变' : '尚未配置'}" autocomplete="new-password" spellcheck="false"></label>
          <label class="wide"><span>模型专属 Anchor 路径</span><input name="anchorPath" type="text" value="${escapeHtml(profile.anchorPath ?? '')}" placeholder="anchors/...json" spellcheck="false"></label>
          <label class="toggle-field wide"><input name="clearApiKey" type="checkbox"><span>保存时清除现有 Key</span></label>
        </div>
        <p class="form-note">Key 只写入本机 <code>gateway.config.json</code>，页面永远读不回明文；Harness 自带 Key 会被丢弃。</p>
        <button class="button primary" type="submit">保存并热应用 ${escapeHtml(profile.name.toUpperCase())}</button>
      </form>
    </article>`).join('')
}

const jobStatusLabels = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已生成并启用',
  failed: '失败',
}

function renderAnchorJobs() {
  if (!state.jobs.length) {
    elements.anchorJobs.innerHTML = ''
    return
  }
  elements.anchorJobs.innerHTML = state.jobs.slice(0, 5).map((job) => `
    <div class="job-card">
      <div>
        <strong>${escapeHtml(job.profile.toUpperCase())} · ${escapeHtml(job.anchorId)}</strong>
        <small>${job.error ? escapeHtml(job.error) : `${job.runs} 个候选 · 最多 ${job.maximumUpstreamCalls} 次请求${job.artifactPath ? ` · ${escapeHtml(job.artifactPath)}` : ''}`}</small>
      </div>
      <span class="job-status ${escapeHtml(job.status)}">${escapeHtml(jobStatusLabels[job.status] ?? job.status)}</span>
    </div>`).join('')
}

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
  if (health.deploymentMode === 'split') {
    elements.configList.innerHTML = `
      <div><dt>管理界面</dt><dd>${escapeHtml(location.origin)}</dd></div>
      <div><dt>部署模式</dt><dd>split · 管理/数据分离</dd></div>
      ${instances.map((instance) => `
        <div><dt>${escapeHtml(instance.profile)} 数据面</dt><dd>${escapeHtml(instance.baseUrl)}</dd></div>
        <div><dt>${escapeHtml(instance.profile)} Key</dt><dd>${instance.gatewayApiKeyConfigured ? instance.gatewayApiKeySource === 'shared-fallback' ? '已配置 · 当前继承共享 Key' : '已独立配置' : '未配置 · 该端口不可用'}</dd></div>
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
  renderProfiles()
  renderAnchorControls()
  renderConfig()
}

async function loadData({ quiet = false } = {}) {
  if (state.loading) return
  state.loading = true
  if (!quiet) setConnection('waiting', '正在连接')
  elements.refreshButton.disabled = true
  try {
    const [health, diagnostics, config, jobs] = await Promise.all([
      fetchJson('/__gateway/health'),
      fetchJson('/__gateway/diagnostics?limit=100'),
      fetchOptionalJson('/__gateway/config', { profiles: [] }),
      fetchOptionalJson('/__gateway/anchors/jobs', { jobs: [] }),
    ])
    state.health = health
    state.config = config
    state.jobs = Array.isArray(jobs.jobs) ? jobs.jobs : []
    state.entries = Array.isArray(diagnostics.entries) ? diagnostics.entries : []
    state.markerProfile = diagnostics.markerProfile ?? health.trajectoryMarkerProfile ?? null
    if (!state.entries.some((entry) => entry.requestId === state.selectedId)) {
      state.selectedId = state.entries[0]?.requestId ?? null
    }
    setConnection(
      health.gatewayApiKeyConfigured ? 'online' : 'locked',
      health.gatewayApiKeyConfigured ? 'Gateway 在线' : '缺少 Gateway Key',
    )
    elements.lastUpdated.textContent = `最后刷新 ${formatTime(new Date().toISOString())}`
    renderAll()
  } catch (error) {
    if (error.status === 401) {
      setConnection('locked', '需要管理令牌')
      if (!elements.tokenDialog.open) elements.tokenDialog.showModal()
    } else {
      setConnection('offline', '连接失败')
      if (!quiet) toast('无法读取 Gateway 状态')
    }
  } finally {
    state.loading = false
    elements.refreshButton.disabled = false
  }
}

function selectRequest(id) {
  state.selectedId = id
  renderRows()
  renderDetail()
}

elements.requestRows.addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-request-id]')
  if (row) selectRequest(row.dataset.requestId)
})

elements.requestRows.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return
  const row = event.target.closest('tr[data-request-id]')
  if (!row) return
  event.preventDefault()
  selectRequest(row.dataset.requestId)
})

elements.detailPanel.addEventListener('click', (event) => {
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
  const maximumCalls = runs * maxSubturns
  if (!window.confirm(`将为 ${profile.toUpperCase()} 生成专属 Anchor，最多发起 ${maximumCalls} 次计费上游请求。继续吗？`)) return
  const submit = elements.anchorForm.querySelector('button[type="submit"]')
  submit.disabled = true
  submit.textContent = '已启动生成任务'
  try {
    const result = await fetchJson('/__gateway/anchors/jobs', {
      method: 'POST',
      body: { profile, runs, maxSubturns, maxTokens },
    })
    state.jobs = [result.job, ...state.jobs]
    renderAnchorControls()
    toast('Anchor 生成任务已启动；完成后会自动绑定，已启用数据面会热应用')
  } catch (error) {
    toast(`无法启动：${error.message}`)
    submit.disabled = false
  } finally {
    submit.textContent = '开始生成'
  }
})

elements.searchInput.addEventListener('input', renderRows)
elements.statusFilter.addEventListener('change', renderRows)
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

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && elements.autoRefresh.checked) loadData({ quiet: true })
})

loadData()
