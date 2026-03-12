const { generateAgentReply, generateAgentReplyStream } = require('../lib/llm')

async function createAgentReply({ threadId, agent, task, messageId, threadMessages, updateMessage, composeMockReply }) {
  const messages = buildModelMessages({ threadMessages, agent, task })
  const attempts = [{ provider: agent.provider, model: agent.model, label: 'primary' }]

  if (agent.fallbackProvider && agent.fallbackModel) {
    attempts.push({
      provider: agent.fallbackProvider,
      model: agent.fallbackModel,
      label: 'provider-fallback',
    })
  }

  const errors = []

  for (const attempt of attempts) {
    const streamed = await generateAgentReplyStream({
      provider: attempt.provider,
      model: attempt.model,
      messages,
      onThinkingDelta: (_delta, fullThinking) => {
        updateMessage(threadId, messageId, {
          meta: {
            thinking: fullThinking,
            provider: attempt.provider,
            model: attempt.model,
            delivery: attempt.label === 'primary' ? 'live' : 'provider-fallback',
            streaming: true,
          },
        })
      },
      onContentDelta: (_delta, fullContent) => {
        updateMessage(threadId, messageId, {
          content: fullContent,
          meta: {
            provider: attempt.provider,
            model: attempt.model,
            delivery: attempt.label === 'primary' ? 'live' : 'provider-fallback',
            streaming: true,
          },
        })
      },
    })

    const result = streamed.ok
      ? streamed
      : await generateAgentReply({
          provider: attempt.provider,
          model: attempt.model,
          messages,
        })

    if (result.ok) {
      return {
        text:
          attempt.label === 'primary'
            ? result.text
            : `${result.text}\n\n[provider fallback] ${attempt.provider}:${attempt.model}`,
        meta: {
          delivery: attempt.label === 'primary' ? 'live' : 'provider-fallback',
          provider: attempt.provider,
          model: attempt.model,
          viaFallback: attempt.label !== 'primary',
          thinking: result.thinking || null,
          errors: errors.length > 0 ? errors : null,
        },
      }
    }

    errors.push(`${attempt.provider}:${attempt.model} -> ${result.reason}`)
  }

  return {
    text: [composeMockReply(agent, task), '', `[mock fallback] ${errors.join(' | ')}`].join('\n'),
    meta: {
      delivery: 'mock-fallback',
      provider: null,
      model: null,
      viaFallback: true,
      thinking: null,
      errors,
    },
  }
}

function buildModelMessages({ threadMessages, agent, task }) {
  const history = (threadMessages || [])
    .slice(-8)
    .map((message) => ({
      role: message.authorType === 'user' ? 'user' : 'assistant',
      content: formatMessageForModel(message),
    }))

  return [
    { role: 'system', content: agent.systemPrompt },
    {
      role: 'system',
      content:
        '你在一个多 Agent 协作工作台里。只代表你自己发言，不要代替其他猫回答，不要重复转述给其他猫的任务，不要输出新的 @mention 指令，除非你明确被要求发起协作。控制在 3 到 8 行内。',
    },
    ...history,
    {
      role: 'user',
      content: `当前分配给你的任务：${sanitizeTaskForAgent(agent, task)}`,
    },
  ]
}

function formatMessageForModel(message) {
  if (message.authorType === 'system' && message.authorName === 'A2A 路由') {
    return `系统路由通知：${message.content}`
  }

  return `${message.authorName}: ${message.content}`
}

function sanitizeTaskForAgent(agent, task) {
  const scopedTask = extractAgentTaskSegment(agent, task)
  const cleaned = scopedTask
    .replace(/@[\S]+/g, '')
    .replace(/并请/g, '并由其他猫另行处理')
    .replace(/再请/g, '再由其他猫另行处理')
    .trim()

  return `${cleaned}\n\n只完成你自己的部分，不要替其他猫总结。`
}

function extractAgentTaskSegment(agent, task) {
  const names = [agent.name, ...(agent.aliases || [])].map((name) => `@${name}`)
  const segments = task
    .split(/[；;\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean)

  const matched = segments.filter((segment) => names.some((name) => segment.includes(name)))
  if (matched.length > 0) {
    return matched.join('；')
  }

  return task
}

function describeRuntimeStrategy(agent) {
  if (agent.provider === 'openai') return 'HTTP直连'
  if (agent.provider === 'zhipu') return 'HTTP直连'
  if (agent.provider === 'gemini') return '代理直连'
  if (agent.provider === 'codex-cli') return 'CLI试点'
  return '自定义'
}

module.exports = {
  createAgentReply,
  describeRuntimeStrategy,
}
