const fs = require('fs')
const path = require('path')

const dataDir = path.resolve(__dirname, '../data')
const avatarMetaFile = path.join(dataDir, 'avatars.json')
const avatarImageDir = path.join(dataDir, 'avatars')

function ensureAvatarStorage() {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(avatarImageDir, { recursive: true })

  if (!fs.existsSync(avatarMetaFile)) {
    fs.writeFileSync(avatarMetaFile, JSON.stringify({}, null, 2))
  }
}

function loadAvatarMeta() {
  ensureAvatarStorage()

  try {
    return JSON.parse(fs.readFileSync(avatarMetaFile, 'utf8'))
  } catch {
    return {}
  }
}

function saveAgentAvatar(agentId, payload) {
  const current = loadAvatarMeta()
  current[agentId] = {
    ...(current[agentId] || {}),
    ...payload,
  }
  fs.writeFileSync(avatarMetaFile, JSON.stringify(current, null, 2))
  return current[agentId]
}

function writeAvatarImage(agentId, base64Data) {
  ensureAvatarStorage()
  const fileName = `${agentId}.png`
  const filePath = path.join(avatarImageDir, fileName)
  fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'))
  return `/assets/avatars/${fileName}`
}

async function downloadAvatarImage(agentId, remoteUrl) {
  ensureAvatarStorage()
  const response = await fetch(remoteUrl)
  if (!response.ok) {
    throw new Error(`Failed to download avatar image: HTTP ${response.status}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const fileName = `${agentId}.png`
  const filePath = path.join(avatarImageDir, fileName)
  fs.writeFileSync(filePath, Buffer.from(arrayBuffer))
  return `/assets/avatars/${fileName}`
}

module.exports = {
  ensureAvatarStorage,
  loadAvatarMeta,
  saveAgentAvatar,
  writeAvatarImage,
  downloadAvatarImage,
  avatarImageDir,
}
