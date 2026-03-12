require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') })

const express = require('express')
const cors = require('cors')
const path = require('path')
const { WebSocketServer } = require('ws')
const { AGENTS } = require('./lib/agent-config')
const { generateAgentReply, CODEX_CLI_PATH } = require('./lib/llm')
const { configureGlobalProxy } = require('./lib/network')
const { ensureAvatarStorage, loadAvatarMeta, saveAgentAvatar, writeAvatarImage, downloadAvatarImage, avatarImageDir } = require('./lib/avatar-store')
const { generateAvatarImage, IMAGE_BASE_URL, IMAGE_MODEL } = require('./lib/images')
const { createAgentReply, describeRuntimeStrategy } = require('./runtime/chat-runtime')
const { nextAgentHandoff } = require('./runtime/a2a-routing')
const { handleAvatarDesignFlow, shouldHandleAvatarDesign } = require('./runtime/avatar-workflow')

const app = express()
app.use(cors())
app.use(express.json())
ensureAvatarStorage()
app.use('/assets/avatars', express.static(avatarImageDir))

const PORT = process.env.PORT || 3001
let wss
const proxyState = configureGlobalProxy()
hydrateAgentAvatars()

const state = {
  threads: [],
  messagesByThread: {},
  agentStatuses: AGENTS.map((agent) => ({ ...agent, status: 'idle' })),
  avatarDraftsByThread: {},
  userProfile: {
    id: 'caretaker',
    name: '铲屎官',
    role: '猫咖主理人',
    title: '店主',
    accent: 'espresso',
    avatar: loadAvatarMeta().caretaker || {
      emoji: '🫖',
      badge: '☕',
      motto: '给猫猫派活的人',
    },
  },
}

createThread('欢迎来到 Cat Café')
addMessage(state.threads[0].id, {
  authorType: 'system',
  authorName: '系统',
  content: '这是 MVP 协作版。你可以用 @布偶猫 @缅因猫 @暹罗猫 发起多猫协作。',
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/agents', (_req, res) => {
  res.json(state.agentStatuses)
})

app.get('/api/profile', (_req, res) => {
  res.json(state.userProfile)
})

app.post('/api/agents/:agentId/avatar/generate', async (req, res) => {
  const agent = AGENTS.find((item) => item.id === req.params.agentId)
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' })
  }

  setAgentStatus(agent.id, 'thinking')

  const designer = AGENTS.find((item) => item.id === 'siamese') || agent
  const styleResult = await generateAvatarStyleGuide()
  const promptResult = await generateAvatarPrompt(designer, agent, styleResult.styleGuide)
  if (!promptResult.ok) {
    setAgentStatus(agent.id, 'idle')
    return res.status(400).json({ error: promptResult.reason })
  }

  const imageResult = await generateAvatarImage(promptResult.prompt)
  if (!imageResult.ok) {
    setAgentStatus(agent.id, 'idle')
    return res.status(502).json({
      error: imageResult.reason,
      hint: `Current image endpoint: ${IMAGE_BASE_URL}`,
    })
  }

  const imageUrl = imageResult.kind === 'base64'
    ? writeAvatarImage(agent.id, imageResult.base64)
    : await downloadAvatarImage(agent.id, imageResult.remoteUrl)
  const avatar = {
    ...(agent.avatar || {}),
    imageUrl,
    remoteImageUrl: imageResult.remoteUrl || null,
    prompt: promptResult.prompt,
    styleGuide: styleResult.styleGuide,
    updatedAt: new Date().toISOString(),
  }

  saveAgentAvatar(agent.id, avatar)
  agent.avatar = avatar
  syncAgentState(agent.id, { avatar })
  setAgentStatus(agent.id, 'idle')
  broadcast('agent_statuses', state.agentStatuses)

  res.json({
    ok: true,
    agentId: agent.id,
    imageUrl,
    prompt: promptResult.prompt,
    styleGuide: styleResult.styleGuide,
    revisedPrompt: imageResult.revisedPrompt,
    imageModel: IMAGE_MODEL,
  })
})

app.post('/api/agents/generate-all-avatars', async (_req, res) => {
  const results = []
  const styleResult = await generateAvatarStyleGuide()

  for (const agent of AGENTS) {
    try {
      const designer = AGENTS.find((item) => item.id === 'siamese') || agent
      const promptResult = await generateAvatarPrompt(designer, agent, styleResult.styleGuide)
      if (!promptResult.ok) {
        results.push({ agentId: agent.id, ok: false, reason: promptResult.reason })
        continue
      }

      const imageResult = await generateAvatarImage(promptResult.prompt)
      if (!imageResult.ok) {
        results.push({ agentId: agent.id, ok: false, reason: imageResult.reason })
        continue
      }

      const imageUrl = imageResult.kind === 'base64'
        ? writeAvatarImage(agent.id, imageResult.base64)
        : await downloadAvatarImage(agent.id, imageResult.remoteUrl)
      const avatar = {
        ...(agent.avatar || {}),
        imageUrl,
        remoteImageUrl: imageResult.remoteUrl || null,
        prompt: promptResult.prompt,
        styleGuide: styleResult.styleGuide,
        updatedAt: new Date().toISOString(),
      }
      saveAgentAvatar(agent.id, avatar)
      agent.avatar = avatar
      syncAgentState(agent.id, { avatar })
      results.push({ agentId: agent.id, ok: true, imageUrl })
    } catch (error) {
      results.push({ agentId: agent.id, ok: false, reason: error.message })
    }
  }

  broadcast('agent_statuses', state.agentStatuses)
  res.json({ ok: true, results })
})

app.get('/api/providers', (_req, res) => {
  res.json(
    AGENTS.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      provider: agent.provider,
      model: agent.model,
      runtimeStrategy: describeRuntimeStrategy(agent),
      configured: isProviderConfigured(agent.provider),
      fallbackProvider: agent.fallbackProvider || null,
      fallbackModel: agent.fallbackModel || null,
      fallbackConfigured: agent.fallbackProvider ? isProviderConfigured(agent.fallbackProvider) : false,
    })),
  )
})

app.get('/api/runtime', (_req, res) => {
  res.json({
    proxyEnabled: proxyState.enabled,
    proxyUrl: proxyState.enabled ? maskProxy(proxyState.proxyUrl) : null,
    imageBaseUrl: IMAGE_BASE_URL,
    imageModel: IMAGE_MODEL,
    codexCliPath: CODEX_CLI_PATH,
  })
})

app.get('/api/threads', (_req, res) => {
  res.json(state.threads)
})

app.post('/api/threads', (req, res) => {
  const thread = createThread(req.body?.title)
  broadcast('thread_created', thread)
  res.status(201).json(thread)
})

app.get('/api/threads/:threadId/messages', (req, res) => {
  res.json(state.messagesByThread[req.params.threadId] || [])
})

app.post('/api/threads/:threadId/messages', (req, res) => {
  const { threadId } = req.params
  const content = String(req.body?.content || '').trim()

  if (!state.messagesByThread[threadId]) {
    return res.status(404).json({ error: 'Thread not found' })
  }

  if (!content) {
    return res.status(400).json({ error: 'Content is required' })
  }

  const userMessage = addMessage(threadId, {
    authorType: 'user',
    authorName: '铲屎官',
    content,
  })

  const targets = resolveTargets(content)
  targets.forEach((agent) => {
    runAgentFlow({ threadId, agent, task: content, parentMessageId: userMessage.id, depth: 0 })
  })

  res.status(202).json({ ok: true, queuedAgents: targets.map((agent) => agent.name) })
})

const server = app.listen(PORT, () => {
  console.log(`Cat Café server listening on http://localhost:${PORT}`)
})

wss = new WebSocketServer({ server })

wss.on('connection', (socket) => {
  socket.send(
    JSON.stringify({
      type: 'snapshot',
      payload: {
        threads: state.threads,
        messagesByThread: state.messagesByThread,
        agentStatuses: state.agentStatuses,
        userProfile: state.userProfile,
      },
    }),
  )
})

function createThread(title) {
  const thread = {
    id: createId('thread'),
    title: title || `新对话 ${state.threads.length + 1}`,
    createdAt: new Date().toISOString(),
  }

  state.threads.unshift(thread)
  state.messagesByThread[thread.id] = []
  return thread
}

function addMessage(threadId, input) {
  const message = {
    id: createId('msg'),
    authorType: input.authorType,
    authorId: input.authorId || null,
    authorName: input.authorName,
    content: input.content,
    createdAt: new Date().toISOString(),
    parentMessageId: input.parentMessageId || null,
    meta: input.meta || null,
  }

  state.messagesByThread[threadId].push(message)
  broadcast('message_created', { threadId, message })
  return message
}

function updateMessage(threadId, messageId, patch) {
  const list = state.messagesByThread[threadId] || []
  const index = list.findIndex((item) => item.id === messageId)
  if (index === -1) return null

  const previous = list[index]
  const mergedMeta = patch.meta
    ? {
        ...(previous.meta || {}),
        ...patch.meta,
        thinking:
          patch.meta.thinking === null || patch.meta.thinking === undefined
            ? previous.meta?.thinking || null
            : patch.meta.thinking,
      }
    : previous.meta

  list[index] = {
    ...previous,
    ...patch,
    meta: mergedMeta,
  }

  broadcast('message_updated', { threadId, message: list[index] })
  return list[index]
}

function resolveTargets(content) {
  const targets = AGENTS.filter((agent) => {
    const names = [agent.name, ...agent.aliases]
    return names.some((name) => content.includes(`@${name}`))
  })

  return targets.length > 0 ? targets : [AGENTS[0]]
}

function setAgentStatus(agentId, status) {
  state.agentStatuses = state.agentStatuses.map((agent) =>
    agent.id === agentId ? { ...agent, status } : agent,
  )
  broadcast('agent_statuses', state.agentStatuses)
}

function syncAgentState(agentId, patch) {
  state.agentStatuses = state.agentStatuses.map((agent) =>
    agent.id === agentId ? { ...agent, ...patch } : agent,
  )
}

async function runAgentFlow({ threadId, agent, task, parentMessageId, depth }) {
  setAgentStatus(agent.id, 'thinking')
  await wait(700)

  const liveMessage = addMessage(threadId, {
    authorType: 'agent',
    authorId: agent.id,
    authorName: agent.name,
    content: '',
    parentMessageId,
    meta: {
      delivery: 'live',
      provider: agent.provider,
      model: agent.model,
      viaFallback: false,
      streaming: true,
      thinking: '',
      errors: null,
    },
  })

  if (shouldHandleAvatarDesign({ state, threadId, agent, task })) {
    const reply = await handleAvatarDesignFlow({
      state,
      agents: AGENTS,
      threadId,
      requesterAgent: agent,
      task,
      messageId: liveMessage.id,
      updateMessage,
      broadcast,
      syncAgentState,
      saveAgentAvatar,
      writeAvatarImage,
      downloadAvatarImage,
      generateAvatarImage,
      generateAgentReply,
    })

    updateMessage(threadId, liveMessage.id, {
      content: reply.text,
      meta: {
        ...reply.meta,
        streaming: false,
      },
    })

    setAgentStatus(agent.id, 'idle')
    return
  }

  setAgentStatus(agent.id, 'replying')
  await wait(100)

  const reply = await createAgentReply({
    threadId,
    agent,
    task,
    messageId: liveMessage.id,
    threadMessages: state.messagesByThread[threadId] || [],
    updateMessage,
    composeMockReply,
  })
  updateMessage(threadId, liveMessage.id, {
    content: reply.text,
    meta: {
      ...reply.meta,
      streaming: false,
    },
  })

  setAgentStatus(agent.id, 'idle')

  const handoff = nextAgentHandoff({ agent, task, depth, agents: AGENTS })
  if (!handoff) return

  const handoffTask = `${agent.name} 请求 ${handoff.name} 协作：${handoff.instruction}`
  const handoffMessage = addMessage(threadId, {
    authorType: 'system',
    authorName: 'A2A 路由',
    content: `${agent.name} -> @${handoff.name} ${handoff.instruction}`,
    parentMessageId,
  })

  runAgentFlow({
    threadId,
    agent: handoff,
    task: handoffTask,
    parentMessageId: handoffMessage.id,
    depth: depth + 1,
  })
}


function composeMockReply(agent, task) {
  if (agent.id === 'ragdoll') {
    return [
      '我先给出实现骨架：',
      '1. 拆成前端工作台和后端路由服务',
      '2. 先跑通 thread、消息、状态、A2A 主链路',
      `3. 当前任务理解：${stripMentions(task)}`,
    ].join('\n')
  }

  if (agent.id === 'maine') {
    return [
      '我从 review 和测试视角看：',
      '1. 优先保证线程隔离和状态同步',
      '2. WebSocket 事件要保持幂等和可重放',
      `3. 我已检查任务：${stripMentions(task)}`,
    ].join('\n')
  }

  return [
    '我从界面体验角度补充：',
    '1. 状态栏要直观看到三只猫是否忙碌',
    '2. 输入区应降低 @ 指派成本',
    `3. 设计焦点：${stripMentions(task)}`,
  ].join('\n')
}

function isProviderConfigured(provider) {
  if (provider === 'openai') return Boolean(process.env.OPENAI_API_KEY)
  if (provider === 'zhipu') return Boolean(process.env.ZHIPU_API_KEY)
  if (provider === 'gemini') return Boolean(process.env.GEMINI_API_KEY)
  if (provider === 'groq') return Boolean(process.env.GROQ_API_KEY)
  if (provider === 'codex-cli') return true
  return false
}

function hydrateAgentAvatars() {
  const avatarMeta = loadAvatarMeta()
  AGENTS.forEach((agent) => {
    if (avatarMeta[agent.id]) {
      agent.avatar = {
        ...(agent.avatar || {}),
        ...avatarMeta[agent.id],
      }
    }
  })
}

function maskProxy(proxyUrl) {
  return String(proxyUrl).replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:***@')
}

function stripMentions(text) {
  return text.replace(/@[^\s]+/g, '').trim()
}

function broadcast(type, payload) {
  if (!wss) return

  const data = JSON.stringify({ type, payload })

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(data)
    }
  }
}

function createId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
