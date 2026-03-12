async function handleAvatarDesignFlow({
  state,
  agents,
  threadId,
  requesterAgent,
  task,
  messageId,
  updateMessage,
  broadcast,
  syncAgentState,
  saveAgentAvatar,
  writeAvatarImage,
  downloadAvatarImage,
  generateAvatarImage,
  generateAgentReply,
}) {
  try {
    const pendingDraft = state.avatarDraftsByThread[threadId] || null
    const isConfirm = isAvatarDraftConfirmation(task)

    if (pendingDraft && isConfirm) {
      updateMessage(threadId, messageId, {
        content: `收到，我现在按草案为 ${pendingDraft.targetName} 正式生成头像...`,
        meta: {
          provider: requesterAgent.provider,
          model: requesterAgent.model,
          delivery: 'live',
          streaming: true,
        },
      })

      return await finalizeAvatarDraft({
        state,
        agents,
        requesterAgent,
        draft: pendingDraft,
        threadId,
        broadcast,
        syncAgentState,
        saveAgentAvatar,
        writeAvatarImage,
        downloadAvatarImage,
        generateAvatarImage,
      })
    }

    if (pendingDraft && !isConfirm && !/(头像|avatar|形象|profile|立绘)/i.test(task)) {
      state.avatarDraftsByThread[threadId] = {
        ...pendingDraft,
        intent: [pendingDraft.intent, `本轮补充修改：${task}`].filter(Boolean).join('\n'),
        updatedAt: new Date().toISOString(),
      }

      return {
        text: '我收到了你的补充修改。你可以继续细化，或者直接点“确认生成头像”。',
        meta: {
          delivery: 'avatar-draft',
          provider: requesterAgent.provider,
          model: requesterAgent.model,
          viaFallback: false,
          thinking: null,
          errors: null,
        },
      }
    }

    const targetAgent = resolveAvatarTarget({ state, agents, threadId, task })
    const userIntent = buildAvatarIntent({ state, threadId, task, pendingDraft })

    updateMessage(threadId, messageId, {
      content: `我先整理你的设计意图，准备给 ${targetAgent.name} 出一版头像草案...`,
      meta: {
        provider: requesterAgent.provider,
        model: requesterAgent.model,
        delivery: 'live',
        streaming: true,
      },
    })

    const styleResult = await generateAvatarStyleGuide({ agents, userIntent, generateAgentReply })
    const promptResult = await generateAvatarPrompt({
      designerAgent: requesterAgent,
      targetAgent,
      styleGuide: styleResult.styleGuide,
      userIntent,
      generateAgentReply,
    })

    state.avatarDraftsByThread[threadId] = {
      threadId,
      targetId: targetAgent.id,
      targetName: targetAgent.name,
      prompt: promptResult.prompt,
      styleGuide: styleResult.styleGuide,
      intent: userIntent,
      updatedAt: new Date().toISOString(),
    }

    return {
      text: [
        `头像草案 - ${targetAgent.name}`,
        `气质方向：${summarizeIntent(userIntent)}`,
        `视觉语言：${shortenText(styleResult.styleGuide, 120)}`,
        `形象关键词：${extractPromptKeywords(promptResult.prompt)}`,
        `满意就确认生成；不满意就继续告诉我怎么改。`,
      ].join('\n'),
      meta: {
        delivery: 'avatar-draft',
        provider: requesterAgent.provider,
        model: requesterAgent.model,
        viaFallback: false,
        thinking: null,
        errors: null,
        actions: ['confirm-avatar'],
      },
    }
  } catch (error) {
    return {
      text: `我理解了你的头像意图，但在执行过程中出了问题：${error.message}`,
      meta: {
        delivery: 'mock-fallback',
        provider: null,
        model: null,
        viaFallback: true,
        thinking: null,
        errors: [error.message],
      },
    }
  }
}

function shouldHandleAvatarDesign({ state, threadId, agent, task }) {
  if (agent.id !== 'siamese') return false
  return /(头像|avatar|形象|profile|立绘)/i.test(task) || isAvatarDraftConfirmation(task) || Boolean(state.avatarDraftsByThread[threadId])
}

async function finalizeAvatarDraft({
  state,
  agents,
  requesterAgent,
  draft,
  threadId,
  broadcast,
  syncAgentState,
  saveAgentAvatar,
  writeAvatarImage,
  downloadAvatarImage,
  generateAvatarImage,
}) {
  const targetAgent = resolveAvatarTargetById({ state, agents, targetId: draft.targetId })
  const imageResult = await generateAvatarImage(draft.prompt)
  if (!imageResult.ok) {
    return {
      text: `我已经按草案开始出图，但当前失败了：${humanizeImageError(imageResult.reason)}`,
      meta: {
        delivery: 'mock-fallback',
        provider: null,
        model: null,
        viaFallback: true,
        thinking: null,
        errors: [imageResult.reason],
      },
    }
  }

  let imageUrl
  if (imageResult.kind === 'base64') {
    imageUrl = writeAvatarImage(targetAgent.id, imageResult.base64)
  } else {
    try {
      imageUrl = await downloadAvatarImage(targetAgent.id, imageResult.remoteUrl)
    } catch {
      imageUrl = imageResult.remoteUrl
    }
  }

  const avatar = {
    ...(targetAgent.avatar || {}),
    imageUrl,
    remoteImageUrl: imageResult.remoteUrl || null,
    prompt: draft.prompt,
    styleGuide: draft.styleGuide,
    intent: draft.intent,
    updatedAt: new Date().toISOString(),
  }

  saveAgentAvatar(targetAgent.id, avatar)
  if (targetAgent.id === 'caretaker') {
    state.userProfile = { ...state.userProfile, avatar }
    broadcast('user_profile', state.userProfile)
  } else {
    targetAgent.avatar = avatar
    syncAgentState(targetAgent.id, { avatar })
    broadcast('agent_statuses', state.agentStatuses)
  }

  delete state.avatarDraftsByThread[threadId]

  return {
    text: [
      `我已经按确认草案，为 ${targetAgent.name} 生成并更新了新头像。`,
      `设计意图：${summarizeIntent(draft.intent)}`,
      `如果你想继续微调，可以继续 @暹罗猫 描述修改方向。`,
    ].join('\n'),
    meta: {
      delivery: 'live',
      provider: requesterAgent.provider,
      model: requesterAgent.model,
      viaFallback: false,
      thinking: null,
      errors: null,
    },
  }
}

function resolveAvatarTarget({ state, agents, threadId, task }) {
  const pendingDraft = state.avatarDraftsByThread[threadId]
  if (pendingDraft) {
    const targeted = resolveAvatarTargetByScan({ agents, task })
    return targeted || resolveAvatarTargetById({ state, agents, targetId: pendingDraft.targetId })
  }

  if (/(铲屎官|我自己|我本人|我自己也|给我|我的头像|主人)/.test(task)) {
    return state.userProfile
  }

  const directTarget = resolveAvatarTargetByScan({ agents, task })
  if (directTarget) return directTarget

  const history = (state.messagesByThread[threadId] || []).slice(-10).reverse()
  for (const message of history) {
    const matched = resolveAvatarTargetByScan({ agents, task: String(message.content || '') })
    if (matched) return matched
  }

  return state.userProfile
}

function resolveAvatarTargetByScan({ agents, task }) {
  return agents.find((agent) => {
    if (agent.id === 'siamese') return false
    const names = [agent.name, ...(agent.aliases || [])]
    return names.some((name) => task.includes(`@${name}`) || task.includes(name))
  })
}

function resolveAvatarTargetById({ state, agents, targetId }) {
  if (targetId === 'caretaker') return state.userProfile
  return agents.find((agent) => agent.id === targetId) || state.userProfile
}

function buildAvatarIntent({ state, threadId, task, pendingDraft }) {
  if (pendingDraft && !isAvatarDraftConfirmation(task)) {
    return [pendingDraft.intent, `本轮补充修改：${task}`].filter(Boolean).join('\n')
  }

  const history = (state.messagesByThread[threadId] || [])
    .slice(-6)
    .map((message) => `${message.authorName}: ${message.content}`)
    .join('\n')

  return [history, `当前用户要求: ${task}`].filter(Boolean).join('\n')
}

function isAvatarDraftConfirmation(task) {
  return /(确认|就按这版|按这个|可以生成|开始生成|生成吧|出图吧|确认生成)/i.test(task)
}

function summarizeIntent(intent) {
  return String(intent).split('\n').slice(-2).join(' ').trim()
}

function shortenText(text, maxLength) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}...`
}

function extractPromptKeywords(prompt) {
  return shortenText(
    String(prompt || '')
      .replace(/warm editorial cat cafe illustration style/gi, '')
      .replace(/front-facing cat character portrait/gi, '')
      .replace(/square avatar/gi, '')
      .replace(/no text, no watermark/gi, '')
      .replace(/\s+/g, ' ')
      .trim(),
    140,
  )
}

function humanizeImageError(reason) {
  const text = String(reason || '')
  if (/Rate limit/i.test(text)) return '图片接口限流了，稍等几十秒再试一次。'
  if (/quota|balance|resource package/i.test(text)) return '图片额度不足，需要补充额度后再出图。'
  if (/fetch failed|ECONNRESET|timeout/i.test(text)) return '图片网络请求失败，可以稍后重试。'
  return text
}

async function generateAvatarStyleGuide({ agents, userIntent, generateAgentReply }) {
  const designer = agents.find((agent) => agent.id === 'siamese') || agents[0]
  const result = await generateAgentReply({
    provider: designer.provider,
    model: designer.model,
    messages: [
      {
        role: 'system',
        content:
          '你要为一个多猫协作产品定义统一头像风格。只输出一段英文图片风格说明，不要解释，不要 markdown。',
      },
      {
        role: 'user',
        content: [
          'Create a single cohesive visual style guide for three cat avatars in the same product world: warm editorial cat cafe mood, polished illustration, centered square portrait, clean background, expressive face, subtle paper texture, premium but cozy, no text, no watermark. Keep it reusable across all cats while allowing individual identity accents.',
          `User intent and recent discussion:\n${userIntent}`,
        ].join('\n\n'),
      },
    ],
  })

  if (result.ok && result.text) {
    return { ok: true, styleGuide: sanitizeAvatarPrompt(result.text) }
  }

  return {
    ok: true,
    styleGuide:
      'warm editorial cat cafe illustration style, centered square portrait, clean background, polished digital painting, subtle paper texture, expressive face, cozy premium mood, unified visual world, no text, no watermark',
  }
}

async function generateAvatarPrompt({ designerAgent, targetAgent, styleGuide, userIntent, generateAgentReply }) {
  const result = await generateAgentReply({
    provider: designerAgent.provider,
    model: designerAgent.model,
    messages: [
      {
        role: 'system',
        content:
          'You are Siamese cat, the design lead. You are writing a single final English image prompt for a target cat avatar. Output one prompt only. No explanation. No markdown. No numbering.',
      },
      {
        role: 'user',
        content: [
          `Shared style guide from Siamese cat: ${styleGuide}.`,
          `User intent and recent discussion: ${userIntent}.`,
          `Target cat name: ${targetAgent.name}. Target title: ${targetAgent.title}. Target role: ${targetAgent.role}. Target motto: ${targetAgent.avatar?.motto || ''}. Accent color: ${targetAgent.accent}.`,
          'Write a final production-ready prompt for a square profile avatar that follows the shared style guide, but makes the target cat clearly distinct in personality, accessory hints, color accents, and facial expression.',
        ].join(' '),
      },
    ],
  })

  if (result.ok && result.text) {
    return { ok: true, prompt: sanitizeAvatarPrompt(result.text), styleGuide }
  }

  return { ok: true, prompt: defaultAvatarPrompt(targetAgent, styleGuide, userIntent), styleGuide }
}

function defaultAvatarPrompt(agent, styleGuide, userIntent) {
  return [
    styleGuide || 'warm editorial cat cafe illustration style,',
    'front-facing cat character portrait, square avatar, centered composition, clean warm background, polished editorial illustration, cozy cafe mood, expressive face, soft paper texture, no text, no watermark,',
    `${agent.name}, ${agent.title}, ${agent.role},`,
    `${agent.avatar?.motto || ''},`,
    userIntent ? `user intent: ${userIntent},` : '',
    agent.accent === 'amber' ? 'warm amber accents, thoughtful librarian host vibe' : '',
    agent.accent === 'sage' ? 'sage green accents, vigilant reviewer guardian vibe' : '',
    agent.accent === 'coral' ? 'terracotta coral accents, imaginative design muse vibe' : '',
  ].filter(Boolean).join(' ')
}

function sanitizeAvatarPrompt(text) {
  return String(text).replace(/```[\s\S]*?```/g, '').replace(/^[\-\d\.\s]+/, '').trim()
}

module.exports = {
  handleAvatarDesignFlow,
  shouldHandleAvatarDesign,
}
