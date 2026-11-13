import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

const CONFIG_FILE = join(app.getPath('userData'), 'config.json')

// Minimal .env.local loader (no dependency). Reads KEY=VALUE lines from the
// project root and populates process.env for any keys not already set.
function loadDotEnvLocal() {
  for (const dir of [process.cwd(), join(app.getAppPath(), '..'), app.getAppPath()]) {
    const envFile = join(dir, '.env.local')
    if (!existsSync(envFile)) continue
    try {
      for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
        if (key && process.env[key] === undefined) process.env[key] = value
      }
    } catch { /* ignore malformed .env.local */ }
    break
  }
}
loadDotEnvLocal()

const DEFAULT_CONFIG = {
  ttsEnabled: true,
  serialBaud: 115200,
  // 语音识别：默认微软 Azure Speech，未配置/失败自动回退本地 SenseVoice
  asr: {
    provider: 'azure', // 'azure' | 'local'
    azure: {
      key: process.env.AZURE_SPEECH_KEY || '',
      region: process.env.AZURE_SPEECH_REGION || '',
      language: 'zh-CN',
      endpoint: '' // 可选：自定义/代理端点（默认 https://{region}.stt.speech.microsoft.com/...）
    }
  },
  // 云 LLM：任意 OpenAI 兼容接口（DeepSeek / Qwen / Moonshot / 智谱 / OpenAI…）
  llm: {
    baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4o-mini'
  }
}

let config = null

function deepMerge(target, source) {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], source[key])
    } else {
      result[key] = source[key]
    }
  }
  return result
}

export function loadConfig() {
  if (config) return config
  try {
    if (existsSync(CONFIG_FILE)) {
      config = deepMerge(DEFAULT_CONFIG, JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')))
    } else {
      config = { ...DEFAULT_CONFIG }
    }
  } catch {
    config = { ...DEFAULT_CONFIG }
  }
  // .env.local key is the fallback when no key was saved in the UI
  if (!config.llm?.apiKey && process.env.LLM_API_KEY) {
    config.llm = { ...config.llm, apiKey: process.env.LLM_API_KEY }
  } else if (!config.llm?.apiKey && process.env.OPENAI_API_KEY) {
    config.llm = { ...config.llm, apiKey: process.env.OPENAI_API_KEY }
  }
  if (!config.asr?.azure?.key && process.env.AZURE_SPEECH_KEY) {
    config.asr = { ...config.asr, azure: { ...config.asr.azure, key: process.env.AZURE_SPEECH_KEY } }
  }
  if (!config.asr?.azure?.region && process.env.AZURE_SPEECH_REGION) {
    config.asr = { ...config.asr, azure: { ...config.asr.azure, region: process.env.AZURE_SPEECH_REGION } }
  }
  return config
}

export function saveConfig(newConfig) {
  config = deepMerge(config, newConfig)
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
  return config
}

export function getConfig() {
  return config || loadConfig()
}
