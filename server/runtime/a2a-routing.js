async function nextAgentHandoff({ agent, task, depth, agents, threadMessages, replyText, generateAgentReply, parentMessageId }) {
  if (depth > 0) return null

  const planned = await planAgentHandoff({
    agent,
    task,
    agents,
    threadMessages,
    replyText,
    generateAgentReply,
  })

  if (planned) {
    if (isAlreadyDispatched({ threadMessages, parentMessageId, targetAgentId: planned.id })) {
      return null
    }
    return planned
  }

  const fallback = keywordFallback({ agent, task, agents })
  if (fallback && isAlreadyDispatched({ threadMessages, parentMessageId, targetAgentId: fallback.id })) {
    return null
  }

  return fallback
}

async function planAgentHandoff({ agent, task, agents, threadMessages, replyText, generateAgentReply }) {
  const candidateAgents = agents.filter((item) => item.id !== agent.id)

  const result = await runPlannerCall({
    generateAgentReply,
    preferredAgent: agent,
    fallbackAgents: candidateAgents,
    messages: [
      {
        role: 'system',
        content: [
          '你在做多 Agent 协作决策。',
          '请只输出一段 JSON，不要解释，不要 markdown。',
          'JSON schema:',
          '{"action":"none"|"handoff","targetAgentId":"id or null","instruction":"string","reason":"string","expectedOutput":"string","urgency":"low"|"medium"|"high","confidence":0-1}',
          '只有在明显需要别的猫补充时才选择 handoff。',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `当前猫: ${agent.name} (${agent.role})`,
          `可协作对象: ${candidateAgents.map((item) => `${item.id}:${item.name}:${item.role}`).join(' | ')}`,
          `用户任务: ${task}`,
          `当前猫刚刚的回复: ${replyText}`,
          `最近上下文: ${summarizeThread(threadMessages)}`,
          '如果当前回复已经完整，就返回 action=none。',
        ].join('\n'),
      },
    ],
  })

  if (!result.ok || !result.text) return null

  const parsed = parseHandoffJson(result.text)
  if (!parsed || parsed.action !== 'handoff' || !parsed.targetAgentId) return null

  const target = candidateAgents.find((item) => item.id === parsed.targetAgentId)
  if (!target) return null

  const instruction = String(parsed.instruction || '').trim()
  const reason = String(parsed.reason || '').trim()
  if (!instruction) return null

  return {
    ...target,
    instruction,
    reason,
    expectedOutput: String(parsed.expectedOutput || '').trim() || null,
    urgency: normalizeUrgency(parsed.urgency),
    confidence: normalizeConfidence(parsed.confidence),
    routeType: 'planner',
  }
}

async function resolveInitialTargets({ content, agents, threadMessages, generateAgentReply }) {
  const explicitTargets = agents.filter((agent) => {
    const names = [agent.name, ...(agent.aliases || [])]
    return names.some((name) => content.includes(`@${name}`))
  })

  if (explicitTargets.length > 0) {
    return {
      targets: explicitTargets,
      meta: {
        mode: 'explicit-mentions',
        reasonSummary: '用户显式 @ 了目标猫',
      },
    }
  }

  const planned = await planInitialDispatch({ content, agents, threadMessages, generateAgentReply })
  if (planned.targets.length > 0) {
    return planned
  }

  return {
    targets: [agents[0]],
    meta: {
      mode: 'default-fallback',
      reasonSummary: '未指定目标猫，默认交给布偶猫',
    },
  }
}

async function planInitialDispatch({ content, agents, threadMessages, generateAgentReply }) {
  const plannerAgent = agents.find((item) => item.id === 'ragdoll') || agents[0]
  const result = await runPlannerCall({
    generateAgentReply,
    preferredAgent: plannerAgent,
    fallbackAgents: agents.filter((item) => item.id !== plannerAgent.id),
    messages: [
      {
        role: 'system',
        content: [
          '你在做多 Agent 首轮分工。',
          '请只输出一段 JSON，不要解释，不要 markdown。',
          'JSON schema:',
          '{"mode":"single"|"multi","reasonSummary":"string","targets":[{"agentId":"string","goal":"string","reason":"string","expectedOutput":"string","urgency":"low"|"medium"|"high","confidence":0-1}]}'
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `候选猫: ${agents.map((item) => `${item.id}:${item.name}:${item.role}`).join(' | ')}`,
          `当前用户消息: ${content}`,
          `最近上下文: ${summarizeThread(threadMessages)}`,
          '如果只需要一只猫，mode=single；如果需要并行协作，mode=multi。只选择真正必要的猫。',
        ].join('\n'),
      },
    ],
  })

  if (!result.ok || !result.text) {
    return { targets: [], meta: { mode: 'planner-failed', reasonSummary: result.reason || 'planner failed' } }
  }

  const parsed = parseHandoffJson(result.text)
  if (!parsed || !Array.isArray(parsed.targets)) {
    return { targets: [], meta: { mode: 'planner-invalid', reasonSummary: 'planner returned invalid json' } }
  }

  const targets = parsed.targets
    .map((item) => {
      const target = agents.find((agent) => agent.id === item.agentId)
      if (!target) return null

      return {
        ...target,
        routeType: 'initial-planner',
        instruction: String(item.goal || '').trim() || null,
        reason: String(item.reason || '').trim() || null,
        expectedOutput: String(item.expectedOutput || '').trim() || null,
        urgency: normalizeUrgency(item.urgency),
        confidence: normalizeConfidence(item.confidence),
      }
    })
    .filter(Boolean)

  return {
    targets,
    meta: {
      mode: parsed.mode || 'single',
      reasonSummary: String(parsed.reasonSummary || '').trim() || 'planner selected target agents',
      candidates: targets.map((item) => ({
        agentId: item.id,
        reason: item.reason,
        expectedOutput: item.expectedOutput,
        urgency: item.urgency,
        confidence: item.confidence,
      })),
    },
  }
}

function keywordFallback({ agent, task, agents }) {
  if (agent.id === 'ragdoll' && /(review|评审|检查|测试)/i.test(task)) {
    return {
      ...agents[1],
      instruction: '请从代码质量和测试角度补充意见。',
      reason: 'task_mentions_review',
      routeType: 'keyword-fallback',
    }
  }

  if (agent.id === 'ragdoll' && /(设计|UI|界面|视觉)/i.test(task)) {
    return {
      ...agents[2],
      instruction: '请从交互和视觉角度补充方案。',
      reason: 'task_mentions_design',
      routeType: 'keyword-fallback',
    }
  }

  return null
}

function summarizeThread(threadMessages) {
  return (threadMessages || [])
    .slice(-6)
    .map((message) => `${message.authorName}: ${String(message.content || '').slice(0, 200)}`)
    .join(' | ')
}

function parseHandoffJson(text) {
  const cleaned = String(text).trim().replace(/^```json\s*/i, '').replace(/^```/i, '').replace(/```$/, '').trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

function isAlreadyDispatched({ threadMessages, parentMessageId, targetAgentId }) {
  if (!parentMessageId || !targetAgentId) return false
  const parentMessage = (threadMessages || []).find((message) => message.id === parentMessageId)
  const dispatchedIds = parentMessage?.meta?.dispatch?.candidates?.map((item) => item.agentId) || []
  return dispatchedIds.includes(targetAgentId)
}

async function runPlannerCall({ generateAgentReply, preferredAgent, fallbackAgents = [], messages }) {
  const plannerCandidates = [preferredAgent, ...fallbackAgents]

  for (const candidate of plannerCandidates) {
    const result = await generateAgentReply({
      provider: candidate.provider,
      model: candidate.model,
      messages,
    })

    if (result.ok) {
      return result
    }
  }

  return { ok: false, reason: 'all planner providers failed' }
}

function normalizeUrgency(value) {
  if (value === 'high' || value === 'medium' || value === 'low') return value
  return 'medium'
}

function normalizeConfidence(value) {
  const number = Number(value)
  if (Number.isFinite(number)) {
    return Math.max(0, Math.min(1, number))
  }
  return null
}

module.exports = {
  nextAgentHandoff,
  resolveInitialTargets,
}
