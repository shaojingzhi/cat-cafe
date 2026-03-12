import { useEffect, useMemo, useState } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001'
const WS_BASE = import.meta.env.VITE_WS_BASE || 'ws://localhost:3001'

function resolveApiBase(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw.replace(/\/$/, '')
  // allow relative like "/" "/api" etc
  if (raw.startsWith('/')) return raw.replace(/\/$/, '')
  return raw.replace(/\/$/, '')
}

function resolveWsUrl(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''

  // Already a ws(s) URL
  if (raw.startsWith('ws://') || raw.startsWith('wss://')) return raw

  // If given http(s), convert to ws(s)
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw.replace(/^http/, 'ws').replace(/\/$/, '')
  }

  // Relative path: derive from current location (supports reverse proxy)
  if (raw.startsWith('/')) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}${raw}`
  }

  // Fallback: treat as host:port
  const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://'
  return `${protocol}${raw}`
}

function App() {
  const resolvedApiBase = useMemo(() => resolveApiBase(API_BASE), [])
  const resolvedWsUrl = useMemo(() => resolveWsUrl(WS_BASE), [])
  const [threads, setThreads] = useState([])
  const [activeThreadId, setActiveThreadId] = useState('')
  const [messagesByThread, setMessagesByThread] = useState({})
  const [agentStatuses, setAgentStatuses] = useState([])
  const [providerInfo, setProviderInfo] = useState([])
  const [userProfile, setUserProfile] = useState(null)
  const [draft, setDraft] = useState('@布偶猫 规划下一步功能；@缅因猫 review 风险；@暹罗猫 补充页面体验建议。')
  const [isSending, setIsSending] = useState(false)
  const [avatarLoadingId, setAvatarLoadingId] = useState('')
  const [thinkingPrefs, setThinkingPrefs] = useState({})
  const [openAvatarIds, setOpenAvatarIds] = useState({})

  const activeMessages = useMemo(() => messagesByThread[activeThreadId] || [], [activeThreadId, messagesByThread])
  const activeThread = useMemo(() => threads.find((item) => item.id === activeThreadId) || null, [threads, activeThreadId])
  const activeAgentCount = useMemo(() => agentStatuses.filter((agent) => agent.status !== 'idle').length, [agentStatuses])

  useEffect(() => {
    bootstrap()
  }, [])

  useEffect(() => {
    if (!activeThreadId) return
    loadMessages(activeThreadId)
  }, [activeThreadId])

  useEffect(() => {
    let socket
    let retryTimer = null
    let retryCount = 0
    let closedByCleanup = false

    function connect() {
      socket = new WebSocket(resolvedWsUrl)

      socket.onopen = () => {
        retryCount = 0
        // eslint-disable-next-line no-console
        console.log('[ws] connected', resolvedWsUrl)
      }

      socket.onerror = (event) => {
        // eslint-disable-next-line no-console
        console.warn('[ws] error', event)
      }

      socket.onclose = (event) => {
        // eslint-disable-next-line no-console
        console.warn('[ws] closed', { code: event.code, reason: event.reason })
        if (closedByCleanup) return

        const base = 600
        const cap = 8000
        const delay = Math.min(cap, base * Math.pow(2, Math.min(5, retryCount)))
        retryCount += 1

        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
          connect()
        }, delay)
      }

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data)

        if (data.type === 'snapshot') {
          setThreads(data.payload.threads)
          setAgentStatuses(data.payload.agentStatuses)
          setMessagesByThread(data.payload.messagesByThread)
          setUserProfile(data.payload.userProfile || null)

          if (!activeThreadId && data.payload.threads[0]) {
            setActiveThreadId(data.payload.threads[0].id)
          }
        }

        if (data.type === 'thread_created') {
          setThreads((current) => [data.payload, ...current.filter((item) => item.id !== data.payload.id)])
          setActiveThreadId(data.payload.id)
        }

        if (data.type === 'message_created') {
          setMessagesByThread((current) => ({
            ...current,
            [data.payload.threadId]: [...(current[data.payload.threadId] || []), data.payload.message],
          }))
        }

        if (data.type === 'message_updated') {
          if (data.payload.message.meta?.thinking) {
            setThinkingPrefs((current) => {
              const existing = current[data.payload.message.id]
              const shouldOpen = shouldOpenThinkingByDefault(data.payload.message)

              if (!existing) {
                return {
                  ...current,
                  [data.payload.message.id]: { open: shouldOpen, manual: false },
                }
              }

              if (existing.manual) return current

              return {
                ...current,
                [data.payload.message.id]: { open: shouldOpen, manual: false },
              }
            })
          }

          setMessagesByThread((current) => ({
            ...current,
            [data.payload.threadId]: (current[data.payload.threadId] || []).map((message) =>
              message.id === data.payload.message.id ? data.payload.message : message,
            ),
          }))
        }

        if (data.type === 'agent_statuses') {
          setAgentStatuses(data.payload)
        }

        if (data.type === 'user_profile') {
          setUserProfile(data.payload)
        }
      }
    }

    connect()

    return () => {
      closedByCleanup = true
      clearTimeout(retryTimer)
      try {
        socket?.close()
      } catch {
        // ignore
      }
    }
  }, [resolvedWsUrl])

  async function bootstrap() {
    const [threadsResponse, statusResponse, providerResponse, profileResponse] = await Promise.all([
      fetch(`${resolvedApiBase}/api/threads`),
      fetch(`${resolvedApiBase}/api/agents`),
      fetch(`${resolvedApiBase}/api/providers`),
      fetch(`${resolvedApiBase}/api/profile`),
    ])

    const threadList = await threadsResponse.json()
    const statuses = await statusResponse.json()
    const providers = await providerResponse.json()
    const profile = await profileResponse.json()

    setThreads(threadList)
    setAgentStatuses(statuses)
    setProviderInfo(providers)
    setUserProfile(profile)

    if (threadList[0]) {
      setActiveThreadId(threadList[0].id)
      await loadMessages(threadList[0].id)
    } else {
      await createThread()
    }
  }

  async function loadMessages(threadId) {
    const response = await fetch(`${resolvedApiBase}/api/threads/${threadId}/messages`)
    const threadMessages = await response.json()
    setMessagesByThread((current) => ({ ...current, [threadId]: threadMessages }))
  }

  async function createThread() {
    const response = await fetch(`${resolvedApiBase}/api/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `今日茶话会 ${threads.length + 1}` }),
    })
    const thread = await response.json()
    setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)])
    setActiveThreadId(thread.id)
    setMessagesByThread((current) => ({ ...current, [thread.id]: [] }))
  }

  async function sendMessage() {
    if (!activeThreadId || !draft.trim() || isSending) return
    setIsSending(true)

    try {
      await fetch(`${resolvedApiBase}/api/threads/${activeThreadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft.trim() }),
      })
      setDraft('')
    } finally {
      setIsSending(false)
    }
  }

  async function sendQuickMessage(content) {
    if (!activeThreadId || !content.trim()) return
    await fetch(`${resolvedApiBase}/api/threads/${activeThreadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  }

  async function generateAvatar(agentId) {
    setAvatarLoadingId(agentId)
    try {
      const response = await fetch(`${resolvedApiBase}/api/agents/${agentId}/avatar/generate`, {
        method: 'POST',
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error.error || '头像生成失败')
      }

      const agentsResponse = await fetch(`${resolvedApiBase}/api/agents`)
      setAgentStatuses(await agentsResponse.json())
    } finally {
      setAvatarLoadingId('')
    }
  }

  function insertMention(agent) {
    setDraft((current) => `${current}${current ? '；' : ''}@${agent.name} `)
  }

  function toggleThinking(messageId) {
    setThinkingPrefs((current) => {
      const existing = current[messageId] || { open: false, manual: false }
      return {
        ...current,
        [messageId]: { open: !existing.open, manual: true },
      }
    })
  }

  function toggleAvatarDetails(agentId) {
    setOpenAvatarIds((current) => ({ ...current, [agentId]: !current[agentId] }))
  }

  return (
    <div className="app-shell">
      <header className="service-strip">
        <div>
          <p className="eyebrow">Cat Cafe</p>
          <h1>三只猫在同一个工作台里协作</h1>
        </div>
        <div className="service-metrics">
          <Metric label="对话数" value={threads.length} />
          <Metric label="活跃猫猫" value={activeAgentCount} />
          <Metric label="已接模型" value={providerInfo.filter((item) => item.configured).length} />
        </div>
      </header>

      <div className="workspace-grid">
        <aside className="thread-rail paper-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Threads</p>
              <h2>茶话会目录</h2>
            </div>
            <button className="ghost-button" onClick={createThread}>新建</button>
          </div>

          <div className="thread-list">
            {threads.map((thread) => (
              <button
                key={thread.id}
                className={`thread-item ${thread.id === activeThreadId ? 'active' : ''}`}
                onClick={() => setActiveThreadId(thread.id)}
              >
                <span className="thread-accent" />
                <strong>{thread.title}</strong>
                <span>{new Date(thread.createdAt).toLocaleString()}</span>
                <div className="thread-chips">
                  {agentStatuses.map((agent) => (
                    <span key={`${thread.id}-${agent.id}`} className={`mini-chip ${agent.accent || 'amber'}`}>
                      {agent.avatar?.badge || '•'} {agent.name}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className="chat-column">
          <section className="conversation-sheet paper-panel">
            <div className="conversation-header">
              <div>
                <p className="eyebrow">Active Thread</p>
                <h2>{activeThread?.title || '新对话'}</h2>
              </div>
              <div className="conversation-note">像菜单板一样分工，像店里交接一样协作。</div>
            </div>

            <div className="messages">
              {activeMessages.map((message) => {
                const agent = findAgentForMessage(message, agentStatuses)
                const actor = message.authorType === 'user' ? userProfile : agent
                return (
                  <article className={`message ${message.authorType}`} key={message.id}>
                    <div className="message-avatar-wrap">
                      <div className={`avatar medallion ${actor?.accent || agent?.accent || 'neutral'}`}>
                        {renderAvatar(actor || agent, message.authorType, resolvedApiBase)}
                      </div>
                    </div>
                    <div className="message-body">
                      <header>
                        <div>
                          <strong>{message.authorName}</strong>
                          {(actor?.title || agent?.title) ? <span className="message-subtitle">{actor?.title || agent?.title}</span> : null}
                        </div>
                        <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
                      </header>
                      {message.meta ? (
                        <div className="message-meta-row">
                          <span className={`message-badge ${message.meta.delivery || 'live'}`}>
                            {deliveryLabel(message.meta.delivery)}
                          </span>
                          {message.meta.provider && message.meta.model ? (
                            <span className="message-provider">
                              {message.meta.provider} / {message.meta.model}
                            </span>
                          ) : null}
                          {message.meta.thinking ? (
                            <button className="tiny-toggle" onClick={() => toggleThinking(message.id)}>
                              {isThinkingOpen(message.id, thinkingPrefs) ? '收起思考' : '展开思考'}
                            </button>
                          ) : null}
                          {message.meta.actions?.includes('confirm-avatar') ? (
                            <button className="tiny-toggle primary" onClick={() => sendQuickMessage('@暹罗猫 确认，生成头像。')}>
                              确认生成头像
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {message.meta?.dispatch ? <DispatchStrip dispatch={message.meta.dispatch} /> : null}
                      {message.meta?.thinking && !isThinkingOpen(message.id, thinkingPrefs) ? (
                        <div className="thinking-preview">
                          <strong>思考摘要</strong>
                          <p>{summarizeThinking(message.meta.thinking)}</p>
                        </div>
                      ) : null}
                      {message.meta?.thinking && isThinkingOpen(message.id, thinkingPrefs) ? (
                        <div className="thinking-panel">
                          <strong>思考过程</strong>
                          <pre>{message.meta.thinking}</pre>
                        </div>
                      ) : null}
                      {message.meta?.toolExecution?.review ? (
                        <div className={`review-strip ${message.meta.toolExecution.review.verdict}`}>
                          <strong>缅因猫 review</strong>
                          <span>{message.meta.toolExecution.review.summary || message.meta.toolExecution.review.reason}</span>
                        </div>
                      ) : null}
                      {message.meta?.toolExecution ? <ToolExecutionCard toolExecution={message.meta.toolExecution} /> : null}
                      <p>{message.content}</p>
                      {message.meta?.handoff ? <HandoffStrip handoff={message.meta.handoff} agents={agentStatuses} /> : null}
                    </div>
                  </article>
                )
              })}
            </div>

            <div className="composer paper-panel inset">
              <div className="composer-toolbar">
                {agentStatuses.map((agent) => (
                  <button
                    key={agent.id}
                    className={`mention-pill ${agent.accent || 'amber'}`}
                    onClick={() => insertMention(agent)}
                  >
                    <span>{agent.avatar?.badge}</span>
                    <span>@{agent.name}</span>
                  </button>
                ))}
              </div>

              <textarea
                rows="4"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="像给店里三只猫排班一样写任务：每只猫一段，职责更清楚。"
              />

              <div className="composer-footer">
                <span>支持真实调用、备用模型回退和多猫分段任务。</span>
                <button className="send-button" onClick={sendMessage} disabled={isSending || !draft.trim()}>
                  {isSending ? '送单中...' : '发给猫猫'}
                </button>
              </div>
            </div>
          </section>
        </main>

        <aside className="cat-roster paper-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Roster</p>
              <h2>今日值班猫</h2>
            </div>
          </div>

          <div className="roster-list">
            {userProfile ? (
              <section className={`roster-card ${userProfile.accent || 'neutral'}`} key={userProfile.id}>
                <div className="roster-top">
                  <div className={`avatar portrait ${userProfile.accent || 'neutral'}`}>
                    {renderAvatar(userProfile, 'user', resolvedApiBase)}
                  </div>
                  <div>
                    <h3>{userProfile.name}</h3>
                    <p className="roster-title">{userProfile.title}</p>
                  </div>
                </div>
                <p className="roster-motto">{userProfile.avatar?.motto}</p>
                {(userProfile.avatar?.prompt || userProfile.avatar?.styleGuide) ? (
                  <>
                    <button className="tiny-toggle" onClick={() => toggleAvatarDetails(userProfile.id)}>
                      {openAvatarIds[userProfile.id] ? '收起设定' : '查看头像设定'}
                    </button>
                    {openAvatarIds[userProfile.id] ? (
                      <div className="avatar-details">
                        {userProfile.avatar?.styleGuide ? (
                          <div>
                            <strong>统一风格</strong>
                            <p>{userProfile.avatar.styleGuide}</p>
                          </div>
                        ) : null}
                        {userProfile.avatar?.prompt ? (
                          <div>
                            <strong>最终 prompt</strong>
                            <p>{userProfile.avatar.prompt}</p>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : null}
            {agentStatuses.map((agent) => {
              const provider = providerInfo.find((item) => item.id === agent.id)
              return (
                <section className={`roster-card ${agent.accent || 'amber'}`} key={agent.id}>
                  <div className="roster-top">
                    <div className={`avatar portrait ${agent.accent || 'amber'}`}>
                      {renderAvatar(agent, 'agent', resolvedApiBase)}
                    </div>
                    <div>
                      <h3>{agent.name}</h3>
                      <p className="roster-title">{agent.title}</p>
                    </div>
                  </div>
                  <p className="roster-motto">{agent.avatar?.motto}</p>
                  <div className="roster-meta">
                    <span>{agent.role}</span>
                    <span className={`status-pill ${agent.status}`}>{labelForStatus(agent.status)}</span>
                  </div>
                  <div className="provider-stack">
                    <span>{provider?.provider}/{provider?.model}</span>
                    {provider?.runtimeStrategy ? <span className="runtime-chip">{provider.runtimeStrategy}</span> : null}
                    {provider?.fallbackConfigured ? (
                      <span>备用 {provider.fallbackProvider}/{provider.fallbackModel}</span>
                    ) : null}
                  </div>
                  <button
                    className="ghost-button avatar-button"
                    onClick={() => generateAvatar(agent.id)}
                    disabled={avatarLoadingId === agent.id}
                  >
                    {avatarLoadingId === agent.id ? '生成中...' : agent.avatar?.imageUrl ? '重新生成头像' : '生成头像'}
                  </button>
                  {(agent.avatar?.prompt || agent.avatar?.styleGuide) ? (
                    <>
                      <button className="tiny-toggle" onClick={() => toggleAvatarDetails(agent.id)}>
                        {openAvatarIds[agent.id] ? '收起设定' : '查看头像设定'}
                      </button>
                      {openAvatarIds[agent.id] ? (
                        <div className="avatar-details">
                          {agent.avatar?.styleGuide ? (
                            <div>
                              <strong>统一风格</strong>
                              <p>{agent.avatar.styleGuide}</p>
                            </div>
                          ) : null}
                          {agent.avatar?.prompt ? (
                            <div>
                              <strong>最终 prompt</strong>
                              <p>{agent.avatar.prompt}</p>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </section>
              )
            })}
          </div>
        </aside>
      </div>
    </div>
  )
}

function Metric({ label, value }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function DispatchStrip({ dispatch }) {
  const candidates = dispatch.candidates || []

  return (
    <div className="chain-strip dispatch-strip">
      <span className="chain-label">已派给</span>
      <div className="chain-nodes">
        {candidates.slice(0, 2).map((candidate) => (
          <span key={candidate.agentId} className="chain-node">
            {agentNameFromId(candidate.agentId)}
          </span>
        ))}
        {candidates.length > 2 ? <span className="chain-node muted">+{candidates.length - 2}</span> : null}
      </div>
      {dispatch.reasonSummary ? <span className="chain-reason">{dispatch.reasonSummary}</span> : null}
    </div>
  )
}

function HandoffStrip({ handoff, agents }) {
  const fromName = agentNameFromId(handoff.fromAgentId, agents)
  const toName = agentNameFromId(handoff.toAgentId, agents)

  return (
    <div className="chain-strip handoff-strip">
      <span className="chain-label">继续交接</span>
      <div className="chain-flow">
        <span className="chain-node">{fromName}</span>
        <span className="chain-arrow">{'->'}</span>
        <span className="chain-node">{toName}</span>
      </div>
      {handoff.reason ? <span className="chain-reason">{handoff.reason}</span> : null}
    </div>
  )
}

function ToolExecutionCard({ toolExecution }) {
  const lines = []

  if (toolExecution.changedFiles?.length) {
    lines.push(`已修改：${toolExecution.changedFiles.join('、')}`)
  }

  if (toolExecution.checkedFiles?.length) {
    lines.push(`已校验：${toolExecution.checkedFiles.join('、')}`)
  }

  if (toolExecution.autoRetry) {
    lines.push('状态：缅因猫给出反馈后已自动再修一轮')
  }

  if (lines.length === 0) return null

  return (
    <div className="tool-card">
      <strong>修复结果</strong>
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  )
}

function findAgentForMessage(message, agentStatuses) {
  return agentStatuses.find((agent) => agent.id === message.authorId || agent.name === message.authorName) || null
}

function agentNameFromId(agentId, agentStatuses = []) {
  const builtins = {
    ragdoll: '布偶猫',
    maine: '缅因猫',
    siamese: '暹罗猫',
    caretaker: '铲屎官',
  }

  return agentStatuses.find((agent) => agent.id === agentId)?.name || builtins[agentId] || agentId
}

function iconForMessage(authorType) {
  if (authorType === 'system') return '☕'
  if (authorType === 'user') return '🫖'
  return '🐾'
}

function renderAvatar(agent, authorType, apiBase) {
  if (agent?.avatar?.imageUrl) {
    const src = agent.avatar.imageUrl.startsWith('http') ? agent.avatar.imageUrl : `${apiBase}${agent.avatar.imageUrl}`
    return <img src={src} alt={agent.name} className="avatar-image" />
  }

  return <span>{agent?.avatar?.emoji || iconForMessage(authorType)}</span>
}

function labelForStatus(status) {
  if (status === 'thinking') return '思考中'
  if (status === 'replying') return '回复中'
  return '空闲中'
}

function deliveryLabel(delivery) {
  if (delivery === 'tool-apply') return '代码修复'
  if (delivery === 'avatar-draft') return '头像草案'
  if (delivery === 'provider-fallback') return '备用模型'
  if (delivery === 'mock-fallback') return 'Mock 回退'
  return '真实调用'
}

function shouldOpenThinkingByDefault(message) {
  if (!message?.meta?.thinking) return false
  if (message.meta.streaming) return true
  return !isLongThinking(message.meta.thinking)
}

function isLongThinking(thinking) {
  const text = String(thinking || '')
  return text.length > 280 || text.split('\n').length > 6
}

function summarizeThinking(thinking) {
  const compact = String(thinking || '').replace(/\s+/g, ' ').trim()
  if (compact.length <= 110) return compact
  return `${compact.slice(0, 109)}...`
}

function isThinkingOpen(messageId, thinkingPrefs) {
  return Boolean(thinkingPrefs[messageId]?.open)
}

export default App
