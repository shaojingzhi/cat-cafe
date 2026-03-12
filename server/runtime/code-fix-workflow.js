const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const ALLOWED_PATHS = ['server/', 'client/src/', 'README.md']
const EXCLUDED_SEGMENTS = ['node_modules', '.git', '.memory', 'dist']

function shouldHandleCodeFix({ agent, task }) {
  if (agent.id !== 'ragdoll') return false
  if (/(头像|avatar|形象|profile|立绘)/i.test(task)) return false
  return /(修复|修好|排查|解决|fix|debug|报错|连不上|无法|异常|错误)/i.test(task)
}

async function handleCodeFixFlow({ state, threadId, agent, task, messageId, updateMessage, generateAgentReply }) {
  try {
    updateMessage(threadId, messageId, {
      content: '我先读取相关代码，定位问题并准备补丁...',
      meta: {
        delivery: 'tool-apply',
        provider: agent.provider,
        model: agent.model,
        streaming: true,
      },
    })

    const relevantFiles = collectRelevantFiles({ state, threadId, task })
    const filePayload = relevantFiles.map((filePath) => ({
      filePath,
      content: fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf8'),
    }))

    const firstAttempt = await runPatchAttempt({ agent, task, generateAgentReply, filePayload })
    if (!firstAttempt.ok) {
      return firstAttempt.response
    }

    if (firstAttempt.review.ok) {
      return successResponse({
        agent,
        summary: firstAttempt.plan.summary,
        applyResult: firstAttempt.applyResult,
        validation: firstAttempt.validation,
        review: firstAttempt.review,
        autoRetry: false,
      })
    }

    rollbackEdits(firstAttempt.applyResult.backups)
    updateMessage(threadId, messageId, {
      content: `缅因猫指出了一些问题，我再修一轮：${firstAttempt.review.reason}`,
      meta: {
        delivery: 'tool-apply',
        provider: agent.provider,
        model: agent.model,
        streaming: true,
      },
    })

    const secondAttempt = await runPatchAttempt({
      agent,
      task: `${task}\n\n缅因猫 review 反馈：${firstAttempt.review.reason}`,
      generateAgentReply,
      filePayload,
    })

    if (!secondAttempt.ok) {
      return secondAttempt.response
    }

    if (!secondAttempt.review.ok) {
      rollbackEdits(secondAttempt.applyResult.backups)
      return rejectedResponse({
        reason: secondAttempt.review.reason,
        applyResult: secondAttempt.applyResult,
        validation: secondAttempt.validation,
        retried: true,
      })
    }

    return successResponse({
      agent,
      summary: secondAttempt.plan.summary,
      applyResult: secondAttempt.applyResult,
      validation: secondAttempt.validation,
      review: secondAttempt.review,
      autoRetry: true,
    })
  } catch (error) {
    return {
      text: `我尝试自动修复时出了问题：${error.message}`,
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

async function runPatchAttempt({ agent, task, generateAgentReply, filePayload }) {
  const plan = await requestFixPlan({ agent, task, generateAgentReply, filePayload })
  if (!plan.ok) {
    return { ok: false, response: failureResponse(`我看了下当前代码，但还不能安全自动修改：${plan.reason}`) }
  }

  if (plan.action !== 'apply' || !Array.isArray(plan.edits) || plan.edits.length === 0) {
    return {
      ok: false,
      response: {
        text: plan.summary || '我分析了问题，但这次更适合先给出建议，不直接改代码。',
        meta: {
          delivery: 'live',
          provider: agent.provider,
          model: agent.model,
          viaFallback: false,
          thinking: null,
          errors: null,
        },
      },
    }
  }

  const applyResult = applyEdits(plan.edits)
  if (!applyResult.ok) {
    return { ok: false, response: failureResponse(`我尝试自动修改，但安全校验没通过：${applyResult.reason}`) }
  }

  const validation = await validateTouchedFiles(applyResult.changedFiles)
  if (!validation.ok) {
    rollbackEdits(applyResult.backups)
    return { ok: false, response: failureResponse(`我已经生成补丁，但基础校验失败，所以回滚了改动：${validation.reason}`) }
  }

  const review = await reviewAppliedPatch({ task, generateAgentReply, changedSnapshots: applyResult.changedSnapshots })
  return { ok: true, plan, applyResult, validation, review }
}

function collectRelevantFiles({ state, threadId, task }) {
  const allFiles = listAllowedFiles(PROJECT_ROOT)
  const keywordPool = extractKeywords(`${task}\n${collectRecentContext(state, threadId)}`)

  const scored = allFiles
    .map((filePath) => ({
      filePath,
      score: scoreFile(filePath, keywordPool),
    }))
    .sort((a, b) => b.score - a.score)

  const top = scored.filter((item) => item.score > 0).slice(0, 6).map((item) => item.filePath)
  if (top.length > 0) return top

  return ['server/index.js', 'server/lib/llm.js', 'server/lib/network.js', 'server/lib/agent-config.js']
}

function listAllowedFiles(root) {
  const results = []

  for (const allowed of ALLOWED_PATHS) {
    const absolute = path.join(root, allowed)
    if (!fs.existsSync(absolute)) continue

    const stat = fs.statSync(absolute)
    if (stat.isFile()) {
      results.push(allowed)
      continue
    }

    walkDir(absolute, (filePath) => {
      const relative = path.relative(root, filePath).replace(/\\/g, '/')
      results.push(relative)
    })
  }

  return results.filter((filePath) => /\.(js|jsx|md)$/.test(filePath))
}

function walkDir(dirPath, visit) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (EXCLUDED_SEGMENTS.includes(entry.name)) continue
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      walkDir(fullPath, visit)
    } else {
      visit(fullPath)
    }
  }
}

function collectRecentContext(state, threadId) {
  return (state.messagesByThread[threadId] || [])
    .slice(-5)
    .map((message) => `${message.authorName}: ${message.content}`)
    .join('\n')
}

function extractKeywords(text) {
  return Array.from(new Set(String(text)
    .toLowerCase()
    .split(/[^a-zA-Z0-9\u4e00-\u9fa5]+/)
    .filter((word) => word.length >= 2)))
}

function scoreFile(filePath, keywords) {
  const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf8').toLowerCase()
  const fileLower = filePath.toLowerCase()
  let score = 0

  for (const keyword of keywords) {
    if (fileLower.includes(keyword)) score += 3
    if (content.includes(keyword)) score += 1
  }

  if (fileLower.includes('network') || fileLower.includes('llm') || fileLower.includes('a2a')) score += 1
  return score
}

async function requestFixPlan({ agent, task, generateAgentReply, filePayload }) {
  const messages = [
    {
      role: 'system',
      content: [
        '你是一个受控补丁生成器。',
        '只能修改提供的文件，不能改 .env .git lockfile。',
        '请只输出 JSON，不要 markdown。',
        'JSON schema:',
        '{"action":"apply"|"advice"|"none","summary":"string","edits":[{"filePath":"string","find":"string","replace":"string"}]}'
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `当前修复任务: ${task}`,
        '允许修改的文件如下：',
        ...filePayload.map((file) => `FILE: ${file.filePath}\n${file.content}`),
        '如果不能安全做精确替换，就返回 action=advice。find 必须是原文件中的精确片段。',
      ].join('\n\n'),
    },
  ]

  const candidates = [
    { provider: agent.provider, model: agent.model },
    agent.fallbackProvider && agent.fallbackModel
      ? { provider: agent.fallbackProvider, model: agent.fallbackModel }
      : null,
  ].filter(Boolean)

  let result = null
  for (const candidate of candidates) {
    result = await generateAgentReply({
      provider: candidate.provider,
      model: candidate.model,
      messages,
    })

    if (result.ok) break
  }

  if (!result.ok || !result.text) {
    return { ok: false, reason: result.reason || 'planner failed' }
  }

  const parsed = parseJson(result.text)
  if (!parsed) {
    return { ok: false, reason: 'tool plan JSON parse failed' }
  }

  return { ok: true, ...parsed }
}

function applyEdits(edits) {
  const backups = []
  const changedFiles = []
  const changedSnapshots = []

  try {
    for (const edit of edits) {
      const filePath = String(edit.filePath || '')
      if (!isAllowedFile(filePath)) {
        throw new Error(`file not allowed: ${filePath}`)
      }

      const absolute = path.join(PROJECT_ROOT, filePath)
      const original = fs.readFileSync(absolute, 'utf8')
      const find = String(edit.find || '')
      const replace = String(edit.replace || '')
      const occurrences = original.split(find).length - 1

      if (!find || occurrences !== 1) {
        throw new Error(`edit must match exactly once: ${filePath}`)
      }

      backups.push({ filePath, original })
      const next = original.replace(find, replace)
      fs.writeFileSync(absolute, next)
      if (!changedFiles.includes(filePath)) changedFiles.push(filePath)
      changedSnapshots.push({ filePath, before: original, after: next })
    }

    return { ok: true, changedFiles, backups, changedSnapshots }
  } catch (error) {
    rollbackEdits(backups)
    return { ok: false, reason: error.message }
  }
}

function rollbackEdits(backups) {
  for (const backup of backups.reverse()) {
    fs.writeFileSync(path.join(PROJECT_ROOT, backup.filePath), backup.original)
  }
}

async function validateTouchedFiles(changedFiles) {
  const checkedFiles = []

  for (const filePath of changedFiles) {
    if (!/\.js$/.test(filePath)) continue
    const ok = await runNodeCheck(path.join(PROJECT_ROOT, filePath))
    checkedFiles.push(filePath)
    if (!ok.ok) {
      return { ok: false, reason: `${filePath}: ${ok.reason}`, checkedFiles }
    }
  }

  return { ok: true, checkedFiles }
}

function runNodeCheck(filePath) {
  return new Promise((resolve) => {
    const child = spawn('node', ['--check', filePath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, reason: stderr.trim() || `exit ${code}` })
    })
    child.on('error', (error) => {
      resolve({ ok: false, reason: error.message })
    })
  })
}

function isAllowedFile(filePath) {
  return ALLOWED_PATHS.some((allowed) => filePath === allowed || filePath.startsWith(allowed))
}

function parseJson(text) {
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

async function reviewAppliedPatch({ task, generateAgentReply, changedSnapshots }) {
  const result = await generateAgentReply({
    provider: 'zhipu',
    model: process.env.MAINE_MODEL || process.env.ZHIPU_MODEL || 'glm-4.7',
    messages: [
      {
        role: 'system',
        content: [
          '你是缅因猫，负责自动 review 补丁。',
          '请只输出 JSON，不要解释，不要 markdown。',
          'JSON schema:',
          '{"verdict":"approved"|"rejected","summary":"string","reason":"string","fixHint":"string"}'
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `当前修复任务: ${task}`,
          ...changedSnapshots.map((item) => `FILE: ${item.filePath}\n--- BEFORE ---\n${item.before}\n--- AFTER ---\n${item.after}`),
          '如果补丁有明显风险、改动不精确、可能破坏现有行为，就 rejected。否则 approved。',
        ].join('\n\n'),
      },
    ],
  })

  if (!result.ok || !result.text) {
    return { ok: false, reason: result.reason || 'review failed' }
  }

  const parsed = parseJson(result.text)
  if (!parsed) {
    return { ok: false, reason: 'review JSON parse failed' }
  }

  if (parsed.verdict !== 'approved') {
    return { ok: false, reason: parsed.reason || parsed.summary || 'review rejected', fixHint: parsed.fixHint || null }
  }

  return {
    ok: true,
    summary: parsed.summary || '补丁通过 review。',
  }
}

function successResponse({ agent, summary, applyResult, validation, review, autoRetry }) {
  return {
    text: [
      summary || '我已经按当前意图自动修了一版。',
      `已修改：${applyResult.changedFiles.join('、')}`,
      validation.checkedFiles.length > 0 ? `已校验：${validation.checkedFiles.join('、')}` : '未执行额外校验。',
      autoRetry ? '缅因猫第一次 review 没通过，我已按反馈自动修正一轮。' : null,
      `缅因猫 review：${review.summary}`,
    ].filter(Boolean).join('\n'),
    meta: {
      delivery: 'tool-apply',
      provider: agent.provider,
      model: agent.model,
      viaFallback: false,
      thinking: null,
      errors: null,
      toolExecution: {
        changedFiles: applyResult.changedFiles,
        checkedFiles: validation.checkedFiles,
        autoRetry,
        review: {
          reviewer: 'maine',
          verdict: 'approved',
          summary: review.summary,
        },
      },
    },
  }
}

function rejectedResponse({ reason, applyResult, validation, retried }) {
  return {
    text: `我已经生成补丁，但缅因猫 review 仍然没通过，所以回滚了改动：${reason}`,
    meta: {
      delivery: 'mock-fallback',
      provider: null,
      model: null,
      viaFallback: true,
      thinking: null,
      errors: [reason],
      toolExecution: {
        changedFiles: applyResult.changedFiles,
        checkedFiles: validation.checkedFiles,
        autoRetry: retried,
        review: {
          reviewer: 'maine',
          verdict: 'rejected',
          reason,
        },
      },
    },
  }
}

function failureResponse(text) {
  return {
    text,
    meta: {
      delivery: 'mock-fallback',
      provider: null,
      model: null,
      viaFallback: true,
      thinking: null,
      errors: [text],
    },
  }
}

module.exports = {
  shouldHandleCodeFix,
  handleCodeFixFlow,
}
