/**
 * 云 LLM 意图解析（任意 OpenAI 兼容接口的 function calling）
 *
 * 输入一句识别出的文字，输出：
 *   { tool: { name, args }, reply }   —— 调用了工具（reply 是给用户播报的话）
 *   { tool: null, reply }             —— 没调工具（追问/闲聊，只播报）
 *   { error: '...' }                  —— 调用失败
 */
import { getConfig } from './config.js'
import { TOOL_DEFINITIONS } from './commands.js'

const SYSTEM_PROMPT = `你是机械臂控制指令解析器。把用户的语音口令解析成工具调用。
规则：
1. 只有用户明确给出数字编号时才调用 run_group / loop_groups。像"抓取""挥手"这类动作名没有编号时，不要猜编号，直接回复询问"请说动作组编号"。
2. move 坐标单位毫米；用户没说耗时就不传 ms。
3. "停/停止/急停/复位/归位/响一声/蜂鸣"等明确口令也用对应工具。
4. 拿不准用户意图时不要调用工具，用 reply 追问，不要猜测。
5. reply 简短（20 字以内），用于语音播报，例如"好的，执行动作组3"。`

export async function parseIntent(text) {
  const config = getConfig()
  const { baseUrl, apiKey, model } = config.llm || {}

  if (!apiKey) {
    return { error: '未配置云 API Key（设置里填 LLM baseUrl / apiKey / model）' }
  }

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const body = {
    model,
    temperature: 0,
    max_tokens: 200,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text }
    ],
    tools: TOOL_DEFINITIONS,
    tool_choice: 'auto'
  }

  let resp
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    })
  } catch (e) {
    return { error: `LLM 请求失败: ${e.message}` }
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    return { error: `LLM 接口错误 ${resp.status}: ${detail.slice(0, 200)}` }
  }

  let data
  try {
    data = await resp.json()
  } catch (e) {
    return { error: `LLM 响应解析失败: ${e.message}` }
  }

  const msg = data.choices?.[0]?.message
  if (!msg) return { error: 'LLM 响应为空' }

  const reply = (msg.content || '').trim()
  const call = msg.tool_calls?.[0]
  if (!call) return { tool: null, reply: reply || '没听懂，请再说一遍' }

  let args = {}
  try {
    args = JSON.parse(call.function?.arguments || '{}')
  } catch { /* 参数坏了就当空对象，交给校验层拒绝 */ }

  return {
    tool: { name: call.function?.name, args },
    reply
  }
}
