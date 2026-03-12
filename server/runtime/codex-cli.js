const { spawn } = require('child_process')
const os = require('os')
const path = require('path')

const CODEX_CLI_PATH = process.env.CODEX_CLI_PATH || path.join(os.homedir(), '.npm-global/bin/codex')

async function generateCodexReply({ model, messages, onThinkingDelta, onContentDelta, cwd }) {
  return new Promise((resolve) => {
    const prompt = buildPrompt(messages)
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--cd',
      cwd || process.cwd(),
      '--model',
      model || process.env.CODEX_MODEL || 'gpt-5-codex',
      prompt,
    ]

    const child = spawn(CODEX_CLI_PATH, args, {
      cwd: cwd || process.cwd(),
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.CODEX_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '',
        OPENAI_BASE_URL: process.env.CODEX_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdoutBuffer = ''
    let stderrBuffer = ''
    let fullContent = ''
    let fullThinking = ''
    let lastError = ''

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue

        try {
          const event = JSON.parse(line)
          handleCodexEvent(event)
        } catch {
          // ignore non-json noise
        }
      }
    })

    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      resolve({ ok: false, reason: error.message })
    })

    child.on('close', () => {
      if (fullContent.trim()) {
        resolve({ ok: true, text: fullContent.trim(), thinking: fullThinking.trim() })
        return
      }

      resolve({
        ok: false,
        reason: lastError || stderrBuffer.trim() || 'Codex CLI returned no content',
      })
    })

    function handleCodexEvent(event) {
      if (event.type === 'error') {
        if (!/Reconnecting/i.test(event.message || '')) {
          lastError = event.message || 'Codex CLI error'
        }
        return
      }

      if (event.type === 'turn.failed') {
        lastError = event.error?.message || 'Codex turn failed'
        return
      }

      if (event.type === 'item.completed') {
        const item = event.item || {}
        const itemType = item.type || item.item_type

        if (itemType === 'reasoning' && item.text) {
          fullThinking += `${fullThinking ? '\n' : ''}${item.text}`
          if (onThinkingDelta) onThinkingDelta(item.text, fullThinking)
          return
        }

        if ((itemType === 'agent_message' || itemType === 'assistant_message') && item.text) {
          fullContent = item.text
          if (onContentDelta) onContentDelta(item.text, fullContent)
        }
      }
    }
  })
}

function buildPrompt(messages) {
  return messages
    .map((message) => `[${message.role}]\n${message.content}`)
    .join('\n\n')
}

module.exports = {
  CODEX_CLI_PATH,
  generateCodexReply,
}
