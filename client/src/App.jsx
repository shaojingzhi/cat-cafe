import { useEffect, useMemo, useState } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001'
const WS_BASE = import.meta.env.VITE_WS_BASE || 'ws://localhost:3001'

function App() {
  const [threads, setThreads] = useState([])
  const [activeThreadId, setActiveThreadId] = useState('')
  const [messagesByThread, setMessagesByThread] = useState({})
  const [agentStatuses, setAgentStatuses] = useState([])
  const [providerInfo, setProviderInfo] = useState([])
  const [userProfile, setUserProfile] = useState(null)
  const [draft, setDraft] = useState('@布偶猫 规划下一步功能；@缅因猫 review 风险；@暹罗猫 补充页面体验建议。')
  const [isSending, setIsSending] = useState(false)
  const [avatarLoadingId, setAvatarLoadingId] = useState('')
  const [openThinkingIds, setOpenThinkingIds] = useState({})
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
    const socket = new WebSocket(`${WS_BASE}`)

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
          setOpenThinkingIds((current) => {
            if (current[data.payload.message.id] !== undefined) return current
            return { ...current, [data.payload.message.id]: true }
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

    return () => socket.close()
  }, [activeThreadId])

  async function bootstrap() {
    const [threadsResponse, statusResponse, providerResponse, profileResponse] = await Promise.all([
      fetch(`${API_BASE}/api/threads`),
      fetch(`${API_BASE}/api/agents`),
      fetch(`${API_BASE}/api/providers`),
      fetch(`${API_BASE}/api/profile`),
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
    const response = await fetch(`${API_BASE}/api/threads/${threadId}/messages`)
    const threadMessages = await response.json()
    setMessagesByThread((current) => ({ ...current, [threadId]: threadMessages }))
  }

  async function createThread() {
    const response = await fetch(`${API_BASE}/api/threads`, {
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
      await fetch(`${API_BASE}/api/threads/${activeThreadId}/messages`, {
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
    await fetch(`${API_BASE}/api/threads/${activeThreadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  }

  async function generateAvatar(agentId) {
    setAvatarLoadingId(agentId)
    try {
      const response = await fetch(`${API_BASE}/api/agents/${agentId}/avatar/generate`, {
        method: 'POST',
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error.error || '头像生成失败')
      }

      const agentsResponse = await fetch(`${API_BASE}/api/agents`)
      setAgentStatuses(await agentsResponse.json())
    } finally {
      setAvatarLoadingId('')
    }
  }

  function insertMention(agent) {
    setDraft((current) => `${current}${current ? '；' : ''}@${agent.name} `)
  }

  function toggleThinking(messageId) {
    setOpenThinkingIds((current) => ({ ...current, [messageId]: !current[messageId] }))
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
                        {renderAvatar(actor || agent, message.authorType, API_BASE)}
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
                              {openThinkingIds[message.id] ? '收起思考' : '查看思考'}
                            </button>
                          ) : null}
                          {message.meta.actions?.includes('confirm-avatar') ? (
                            <button className="tiny-toggle primary" onClick={() => sendQuickMessage('@暹罗猫 确认，生成头像。')}>
                              确认生成头像
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {message.meta?.thinking && openThinkingIds[message.id] ? (
                        <div className="thinking-panel">
                          <strong>思考过程</strong>
                          <pre>{message.meta.thinking}</pre>
                        </div>
                      ) : null}
                      <p>{message.content}</p>
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
                    {renderAvatar(userProfile, 'user', API_BASE)}
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
                      {renderAvatar(agent, 'agent', API_BASE)}
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

function findAgentForMessage(message, agentStatuses) {
  return agentStatuses.find((agent) => agent.id === message.authorId || agent.name === message.authorName) || null
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
  if (delivery === 'avatar-draft') return '头像草案'
  if (delivery === 'provider-fallback') return '备用模型'
  if (delivery === 'mock-fallback') return 'Mock 回退'
  return '真实调用'
}

export default App
