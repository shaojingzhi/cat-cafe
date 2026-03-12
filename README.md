# Cat Café MVP

React 前后分离的最小可行版多 Agent 协作工作台。

## 已实现

- Thread 列表和切换
- 用户消息发送
- @mention 指派三只猫
- 多猫并行回复
- 基础 A2A 路由
- WebSocket 实时状态栏
- 三模型接入骨架：OpenAI、GLM、Gemini
- key 缺失或接口失败时自动回退到 mock
- Gemini 支持走代理环境变量
- 暹罗猫支持 Gemini 失败时自动切到 Groq
- 支持用 OpenAI Images 或 Zhipu glm-image 生成猫猫头像并持久化到本地
- 布偶猫支持 Codex CLI 试点 runtime

## 当前稳定运行策略

- 布偶猫: 当前默认走 OpenAI HTTP 直连
- 缅因猫: 当前默认走 Zhipu HTTP 直连
- 暹罗猫: 当前默认走 Gemini，依赖代理；若未配置 `GROQ_API_KEY`，Gemini 失败时只能回退 mock
- Codex CLI: 已接入试点代码，但当前需要一把真实可用的官方 OpenAI API key 才能真正跑通

## 模型映射

- 布偶猫: OpenAI gpt-5.2
- 缅因猫: GLM 4.7
- 暹罗猫: Gemini 2.5 Flash

## 环境变量

先复制根目录 `.env.example`，再把变量注入到后端启动环境。

需要的 key：

- `OPENAI_API_KEY`
- `ZHIPU_API_KEY`
- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `OPENAI_IMAGE_API_KEY`
- `ZHIPU_IMAGE_API_KEY`
- `CODEX_OPENAI_API_KEY`

可选：

- `OPENAI_MODEL`
- `ZHIPU_MODEL`
- `GEMINI_MODEL`
- `ZHIPU_BASE_URL`
- `GEMINI_BASE_URL`
- `GROQ_MODEL`
- `GROQ_BASE_URL`
- `OPENAI_IMAGE_BASE_URL`
- `OPENAI_IMAGE_MODEL`
- `ZHIPU_IMAGE_BASE_URL`
- `ZHIPU_IMAGE_MODEL`
- `CODEX_CLI_PATH`
- `CODEX_MODEL`
- `CODEX_OPENAI_BASE_URL`
- `CODEX_OPENAI_API_KEY`
- `RAGDOLL_PROVIDER`
- `RAGDOLL_FALLBACK_PROVIDER`
- `RAGDOLL_FALLBACK_MODEL`
- `HTTPS_PROXY`
- `HTTP_PROXY`
- `ALL_PROXY`

## 启动

### 1. 安装依赖

```bash
npm --prefix server install
npm --prefix client install
```

### 2. 配置环境变量

示例：

```bash
export OPENAI_API_KEY=your_key
export ZHIPU_API_KEY=your_key
export GEMINI_API_KEY=your_key
export GROQ_API_KEY=your_key
export OPENAI_IMAGE_API_KEY=your_image_key
export ZHIPU_IMAGE_API_KEY=your_glm_image_key
```

如果图片要走 OpenAI 图片端点，可额外配置：

```bash
export OPENAI_IMAGE_BASE_URL=https://api.openai.com/v1
export OPENAI_IMAGE_MODEL=gpt-image-1
```

如果图片要走智谱图片端点，可额外配置：

```bash
export ZHIPU_IMAGE_BASE_URL=https://api.z.ai/api/paas/v4
export ZHIPU_IMAGE_MODEL=glm-image
```

如果本机到 Google API 超时，可配置代理：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
export ALL_PROXY=socks5://127.0.0.1:7890
```

### 3. 启动后端

```bash
npm --prefix server run dev
```

### 4. 启动前端

```bash
npm --prefix client run dev
```

前端默认地址 http://localhost:5173

后端默认地址 http://localhost:3001

可查看当前三只猫的 provider 配置：

- `GET /api/providers`
- `GET /api/runtime`
- `GET /api/profile`

头像生成接口：

- `POST /api/agents/:agentId/avatar/generate`
- `POST /api/agents/generate-all-avatars`

Codex CLI 说明：

- 当前项目里已接入 `codex exec --json` 试点 runtime，但默认不再让布偶猫优先走它
- 如需重新启用，可把 `RAGDOLL_PROVIDER=codex-cli`
- 如果 Codex CLI 不可用或认证失败，会回退到配置的 fallback provider
- 建议为 Codex CLI 单独配置：

```bash
export CODEX_CLI_PATH="$HOME/.npm-global/bin/codex"
export CODEX_MODEL=gpt-5-codex
export CODEX_OPENAI_API_KEY=your_openai_key
export CODEX_OPENAI_BASE_URL=https://api.openai.com/v1
```
