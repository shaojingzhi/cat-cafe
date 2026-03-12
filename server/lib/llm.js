const { generateCodexReply, CODEX_CLI_PATH } = require('../runtime/codex-cli')
const { Agent } = require('undici')

const DEFAULT_TIMEOUT_MS = 45000
const directDispatcher = new Agent()

const PROVIDERS = {
  openai: {
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    endpoint: '/chat/completions',
  },
  zhipu: {
    baseUrl: process.env.ZHIPU_BASE_URL || 'https://api.z.ai/api/paas/v4',
    apiKey: process.env.ZHIPU_API_KEY,
    endpoint: '/chat/completions',
  },
  gemini: {
    baseUrl:
      process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: process.env.GEMINI_API_KEY,
    endpoint: '/chat/completions',
  },
  groq: {
    baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY,
    endpoint: '/chat/completions',
  },
}

async function generateAgentReply({ provider, model, messages }) {
  if (provider === 'codex-cli') {
    return generateCodexReply({ model, messages, cwd: process.cwd() })
  }

  const providerConfig = PROVIDERS[provider]

  if (!providerConfig) {
    return {
      ok: false,
      reason: `Unknown provider: ${provider}`,
    }
  }

  if (!providerConfig.apiKey) {
    return {
      ok: false,
      reason: `Missing API key for provider: ${provider}`,
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  try {
    const response = await fetch(`${trimSlash(providerConfig.baseUrl)}${providerConfig.endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${providerConfig.apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
      signal: controller.signal,
      dispatcher: shouldBypassProxy(provider, providerConfig.baseUrl) ? directDispatcher : undefined,
    })

    const data = await response.json().catch(() => null)

    if (!response.ok) {
      return {
        ok: false,
        reason: data?.error?.message || data?.message || `HTTP ${response.status}`,
      }
    }

    const content = extractText(data)
    const thinking = extractThinking(data)
    if (!content) {
      return {
        ok: false,
        reason: 'Empty model response',
      }
    }

    return {
      ok: true,
      text: content,
      thinking,
      raw: data,
    }
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'Model request timeout' : error.message,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function generateAgentReplyStream({ provider, model, messages, onThinkingDelta, onContentDelta }) {
  if (provider === 'codex-cli') {
    return generateCodexReply({
      model,
      messages,
      onThinkingDelta,
      onContentDelta,
      cwd: process.cwd(),
    })
  }

  const providerConfig = PROVIDERS[provider]

  if (!providerConfig) {
    return { ok: false, reason: `Unknown provider: ${provider}` }
  }

  if (!providerConfig.apiKey) {
    return { ok: false, reason: `Missing API key for provider: ${provider}` }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  try {
    const response = await fetch(`${trimSlash(providerConfig.baseUrl)}${providerConfig.endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${providerConfig.apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: controller.signal,
      dispatcher: shouldBypassProxy(provider, providerConfig.baseUrl) ? directDispatcher : undefined,
    })

    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => null)
      return {
        ok: false,
        reason: data?.error?.message || data?.message || `HTTP ${response.status}`,
      }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullContent = ''
    let fullThinking = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop() || ''

      for (const event of events) {
        const lines = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())

        if (lines.length === 0) continue
        const payload = lines.join('\n')
        if (payload === '[DONE]') continue

        let json
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }

        const delta = json?.choices?.[0]?.delta || {}
        const thinkingDelta = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
        const contentDelta = extractDeltaContent(delta)

        if (thinkingDelta) {
          fullThinking += thinkingDelta
          if (onThinkingDelta) onThinkingDelta(thinkingDelta, fullThinking)
        }

        if (contentDelta) {
          fullContent += contentDelta
          if (onContentDelta) onContentDelta(contentDelta, fullContent)
        }
      }
    }

    if (!fullContent.trim() && fullThinking.trim()) {
      fullContent = fullThinking
    }

    if (!fullContent.trim()) {
      return { ok: false, reason: 'Empty streamed model response' }
    }

    return {
      ok: true,
      text: fullContent.trim(),
      thinking: fullThinking.trim(),
    }
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'Model request timeout' : error.message,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function extractText(data) {
  const message = data?.choices?.[0]?.message || {}
  const content = message.content

  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (trimmed) return trimmed
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((item) => {
        if (typeof item === 'string') return item
        if (item?.type === 'text') return item.text || ''
        return ''
      })
      .join('\n')
      .trim()

    if (joined) return joined
  }

  if (typeof message.reasoning_content === 'string') {
    const reasoning = message.reasoning_content.trim()
    if (reasoning) return reasoning
  }

  if (typeof data?.output_text === 'string') {
    return data.output_text.trim()
  }

  return ''
}

function extractThinking(data) {
  const message = data?.choices?.[0]?.message || {}

  if (typeof message.reasoning_content === 'string') {
    const reasoning = message.reasoning_content.trim()
    if (reasoning) return reasoning
  }

  if (Array.isArray(data?.choices?.[0]?.message?.content)) {
    const parts = data.choices[0].message.content
      .filter((item) => item?.type === 'reasoning' && item?.text)
      .map((item) => item.text.trim())
      .filter(Boolean)

    if (parts.length > 0) return parts.join('\n')
  }

  return ''
}

function extractDeltaContent(delta) {
  if (typeof delta?.content === 'string') {
    return delta.content
  }

  if (Array.isArray(delta?.content)) {
    return delta.content
      .map((item) => {
        if (typeof item === 'string') return item
        if (item?.type === 'text') return item.text || ''
        return ''
      })
      .join('')
  }

  return ''
}

function trimSlash(text) {
  return text.endsWith('/') ? text.slice(0, -1) : text
}

function shouldBypassProxy(provider, baseUrl) {
  if (provider === 'openai') return true
  if (provider === 'zhipu') return true
  if (/api\.openai\.com|api\.z\.ai|open\.bigmodel\.cn/i.test(baseUrl || '')) return true
  return false
}

module.exports = {
  generateAgentReply,
  generateAgentReplyStream,
  CODEX_CLI_PATH,
}
