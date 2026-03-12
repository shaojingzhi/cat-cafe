function nextAgentHandoff({ agent, task, depth, agents }) {
  if (depth > 0) return null

  if (agent.id === 'ragdoll' && /(review|评审|检查|测试)/i.test(task)) {
    return { ...agents[1], instruction: '请从代码质量和测试角度补充意见。' }
  }

  if (agent.id === 'ragdoll' && /(设计|UI|界面|视觉)/i.test(task)) {
    return { ...agents[2], instruction: '请从交互和视觉角度补充方案。' }
  }

  return null
}

module.exports = {
  nextAgentHandoff,
}
