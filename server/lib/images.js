const { Agent } = require('undici')

const IMAGE_BASE_URL =
  process.env.ZHIPU_IMAGE_BASE_URL ||
  process.env.OPENAI_IMAGE_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  'https://api.openai.com/v1'
const IMAGE_API_KEY =
  process.env.ZHIPU_IMAGE_API_KEY || process.env.OPENAI_IMAGE_API_KEY || process.env.OPENAI_API_KEY
const IMAGE_MODEL = process.env.ZHIPU_IMAGE_MODEL || process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1'
const directDispatcher = new Agent()

async function generateAvatarImage(prompt) {
  if (!IMAGE_API_KEY) {
    return { ok: false, reason: 'Missing image API key' }
  }

  const requestBody = buildImageRequestBody(prompt)
  const response = await requestImageGeneration(requestBody)

  if (!response || response.ok === false && response.error) {
    return { ok: false, reason: response?.error?.message || 'Image request failed' }
  }

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    return { ok: false, reason: data?.error?.message || `HTTP ${response.status}` }
  }

  const first = data?.data?.[0] || {}
  if (first.b64_json) {
    return {
      ok: true,
      kind: 'base64',
      base64: first.b64_json,
      revisedPrompt: first.revised_prompt || null,
      remoteUrl: first.url || null,
    }
  }

  if (first.url) {
    return {
      ok: true,
      kind: 'url',
      remoteUrl: first.url,
      revisedPrompt: first.revised_prompt || null,
    }
  }

  return { ok: false, reason: 'Image response missing image payload' }
}

async function requestImageGeneration(requestBody) {
  let lastError = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${trimSlash(IMAGE_BASE_URL)}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${IMAGE_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
      dispatcher: shouldBypassProxy(IMAGE_BASE_URL) ? directDispatcher : undefined,
    }).catch((error) => ({ ok: false, error }))

    if (response && !(response.ok === false && response.error)) {
      return response
    }

    lastError = response?.error || new Error('Image request failed')
  }

  return { ok: false, error: lastError }
}

function shouldBypassProxy(baseUrl) {
  return /https:\/\/api\.z\.ai/i.test(baseUrl)
}

function buildImageRequestBody(prompt) {
  const body = {
    model: IMAGE_MODEL,
    prompt,
  }

  if (IMAGE_MODEL === 'glm-image') {
    body.size = '1024x1024'
  } else {
    body.size = '1024x1024'
    body.n = 1
    body.response_format = 'b64_json'
  }

  return body
}

function trimSlash(text) {
  return text.endsWith('/') ? text.slice(0, -1) : text
}

module.exports = {
  generateAvatarImage,
  IMAGE_BASE_URL,
  IMAGE_MODEL,
}
