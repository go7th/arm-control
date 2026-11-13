/**
 * 指令层：语音文字 → 机械臂串口指令
 *
 * 固件指令协议（115200 ASCII，来自机械臂项目 app_servo.c）：
 *   $DGS:x!        执行第 x 组动作一次
 *   $DGT:x-y,z!    循环执行第 x 到 y 组动作 z 次
 *   $KMS:x,y,z,t!  运动学移动到 (x,y,z)，耗时 t 毫秒
 *   $DST!          全部舵机停止（急停）
 *   $DJR!          全部舵机复位回中
 *   $BEEP!         蜂鸣器响一声
 *
 * 三条路径（从快到慢）：
 *   1. 急停关键词 —— 永远旁路，直接 $DST!
 *   2. 快速规则   —— 正则命中固定口令，零延时零成本
 *   3. 云 LLM     —— 口语化/复杂指令，function calling 出结构化动作
 */

// ---------- 1. 急停关键词（命中即发，不进任何后续流程） ----------
const STOP_KEYWORDS = ['急停', '停止', '停下', '停', '住嘴', '别动', '安静', '别跑了']

export function matchStop(text) {
  return STOP_KEYWORDS.some(kw => text.includes(kw))
}

// ---------- 2. 快速规则 ----------
// 返回 { command, label, speak } 或 null
export function matchQuickCommand(text) {
  const t = text.trim()

  if (/复位|回中|回原点|归位/.test(t)) {
    return { command: { type: 'reset' }, label: '复位', speak: '好的，复位' }
  }
  if (/蜂鸣|滴一声|滴一下|响一声/.test(t)) {
    return { command: { type: 'beep' }, label: '蜂鸣', speak: '好的' }
  }
  // "第3组" / "动作组3" / "3号动作" / "执行3组"
  const m = t.match(/(?:动作组|动作|组)\s*(\d{1,3})|(\d{1,3})\s*号?\s*(?:动作组|动作|组)/)
  if (m) {
    const id = parseInt(m[1] || m[2], 10)
    const cmd = validate({ type: 'run_group', id })
    if (cmd.ok) return { command: cmd.command, label: `动作组 ${id}`, speak: `好的，执行动作组${id}` }
  }
  return null
}

// ---------- 3. 云 LLM 工具定义（function calling） ----------
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'run_group',
      description: '执行一个已录制的机械臂动作组（动作组编号由用户明确给出）',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '动作组编号 0-200' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'loop_groups',
      description: '循环执行一段连续的动作组',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'integer', description: '起始动作组编号' },
          end: { type: 'integer', description: '结束动作组编号' },
          times: { type: 'integer', description: '循环次数 1-100' }
        },
        required: ['start', 'end', 'times']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move',
      description: '运动学移动：把机械臂末端移动到空间坐标（毫米）',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X 坐标 mm，范围 -300~300' },
          y: { type: 'number', description: 'Y 坐标 mm，范围 0~400' },
          z: { type: 'number', description: 'Z 坐标 mm，范围 -100~400' },
          ms: { type: 'integer', description: '运动耗时毫秒 100-10000，默认 1000' }
        },
        required: ['x', 'y', 'z']
      }
    }
  },
  { type: 'function', function: { name: 'stop', description: '立即停止所有舵机', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'reset', description: '所有舵机复位回中', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'beep', description: '蜂鸣器响一声', parameters: { type: 'object', properties: {} } } }
]

// ---------- 校验：LLM / 规则共用，超范围一律拒绝 ----------
const clamp = (v, lo, hi, name) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return { err: `${name} 不是有效数字` }
  if (n < lo || n > hi) return { err: `${name} 超出范围 ${lo}~${hi}` }
  return { n }
}

export function validate(args) {
  if (!args || typeof args !== 'object') return { ok: false, error: '无效指令' }
  switch (args.type) {
    case 'stop':
      return { ok: true, command: { type: 'stop' } }
    case 'reset':
      return { ok: true, command: { type: 'reset' } }
    case 'beep':
      return { ok: true, command: { type: 'beep' } }
    case 'run_group': {
      const id = clamp(args.id, 0, 200, '动作组编号')
      if (id.err) return { ok: false, error: id.err }
      return { ok: true, command: { type: 'run_group', id: id.n } }
    }
    case 'loop_groups': {
      const s = clamp(args.start, 0, 200, '起始编号')
      const e = clamp(args.end, 0, 200, '结束编号')
      const t = clamp(args.times, 1, 100, '循环次数')
      if (s.err || e.err || t.err) return { ok: false, error: s.err || e.err || t.err }
      if (s.n > e.n) return { ok: false, error: '起始编号不能大于结束编号' }
      return { ok: true, command: { type: 'loop_groups', start: s.n, end: e.n, times: t.n } }
    }
    case 'move': {
      const x = clamp(args.x, -300, 300, 'X')
      const y = clamp(args.y, 0, 400, 'Y')
      const z = clamp(args.z, -100, 400, 'Z')
      const ms = args.ms === undefined ? { n: 1000 } : clamp(args.ms, 100, 10000, '耗时')
      if (x.err || y.err || z.err || ms.err) return { ok: false, error: x.err || y.err || z.err || ms.err }
      return { ok: true, command: { type: 'move', x: x.n, y: y.n, z: z.n, ms: ms.n } }
    }
    default:
      return { ok: false, error: `未知指令类型: ${args.type}` }
  }
}

// ---------- 指令 → 串口字符串 ----------
const fmt = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1)

export function toSerial(command) {
  switch (command.type) {
    case 'stop': return '$DST!'
    case 'reset': return '$DJR!'
    case 'beep': return '$BEEP!'
    case 'run_group': return `$DGS:${command.id}!`
    case 'loop_groups': return `$DGT:${command.start}-${command.end},${command.times}!`
    case 'move': return `$KMS:${fmt(command.x)},${fmt(command.y)},${fmt(command.z)},${command.ms}!`
    default: return null
  }
}

// LLM 工具调用 → 校验后的指令
export function toolCallToCommand(name, args) {
  return validate({ ...(args || {}), type: name })
}

export function describe(command) {
  switch (command.type) {
    case 'stop': return '停止'
    case 'reset': return '复位'
    case 'beep': return '蜂鸣'
    case 'run_group': return `动作组 ${command.id}`
    case 'loop_groups': return `循环 ${command.start}-${command.end} × ${command.times}`
    case 'move': return `移动到 (${command.x}, ${command.y}, ${command.z})`
    default: return JSON.stringify(command)
  }
}
