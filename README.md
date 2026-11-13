# arm-control — 机械臂语音控制台（形态一）

语音 → 离线识别 → 云 LLM 解析 → 串口指令 → 机械臂。
基于 MiniChat 的语音引擎（sherpa-onnx：Silero VAD + SenseVoice 离线识别 + VITS 播报），识别完全离线，只有意图解析走云 API。

```
话筒 → [VAD切句 → SenseVoice离线ASR] → 文字
        ├─ 急停热词  ──────────────────→ $DST!      （旁路，永不过LLM）
        ├─ 快速规则  ──────────────────→ 固定指令    （零延时零成本）
        └─ 云 LLM (function calling) ──→ 结构化动作 → 校验 → 串口 → 机械臂
```

## 快速开始

```bash
npm install          # 依赖已随工程带好，缺了再装
npm run dev          # 启动
```

模型（约 1.2G）复用 MiniChat 的 `models/`（软链接）。单独部署时执行 `npm run download-models`。

## 接线

电脑 USB-TTL（CH340/CP2102）↔ 机械臂 **USART1**：

| USB-TTL | 机械臂 |
|---|---|
| TX | RX（USART1） |
| RX | TX（USART1） |
| GND | GND |

波特率 **115200 8N1**。点「连接串口」选口即可（Web Serial）。

## 语音口令

| 说 | 发送 | 说明 |
|---|---|---|
| 急停 / 停止 / 停 / 住嘴 / 别动 | `$DST!` | **旁路直达**，Esc 键 / 🛑 按钮同款 |
| 复位 / 回中 / 归位 | `$DJR!` | 规则直达 |
| 蜂鸣 / 滴一声 | `$BEEP!` | 规则直达 |
| 第3组 / 动作组3 / 3号动作 | `$DGS:3!` | 规则直达 |
| 其他口语（"转圈两遍"、"移到200,250"） | 云 LLM 解析 | function calling → 校验 → 下发 |

LLM 工具集：`run_group(id)` / `loop_groups(start,end,times)` / `move(x,y,z,ms)` / `stop` / `reset` / `beep`。
所有参数过校验层（动作组 0-200、坐标 mm 限幅、耗时 100-10000ms），超范围拒绝执行。

## 语音识别（ASR）

默认走**微软 Azure Speech**（REST 短语音接口），未配置密钥或调用失败时自动回退本地 SenseVoice（离线）：

| 字段 | 例 | 环境变量 |
|---|---|---|
| Azure Key | 订阅密钥 | `AZURE_SPEECH_KEY` |
| Azure Region | `eastasia` | `AZURE_SPEECH_REGION` |
| 语言 | `zh-CN` | — |

界面无设置表单：密钥写项目根目录 `.env.local`（`AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`），或 `~/Library/Application Support/arm-control/config.json`（重启生效）。VAD 切句和 TTS 播报始终本地运行，与 ASR 后端无关。

## 云 LLM 设置

任意 **OpenAI 兼容** 接口，写进 `.env.local`（界面无设置表单）：

| 字段 | 例 |
|---|---|
| Base URL | `https://api.deepseek.com/v1` |
| API Key | `sk-...` |
| 模型 | `deepseek-chat` |

也可用 `.env.local`：`LLM_BASE_URL=...` `LLM_API_KEY=...` `LLM_MODEL=...`。

## 交互（界面只有四件事）

| 元素 | 作用 |
|---|---|
| **按住说话** | 按下收音、松开识别执行（长按空格同款） |
| **选择硬件** | 选中 USB-TTL 串口并连接（Web Serial） |
| **连接状态** | 连接灯 + 状态 / 识别 / 下发三条只读读数 |
| **操作说明** | 底部抽屉：快速上手、口令速查、接线、密钥配置 |

急停**不设按钮**——**Esc** 键或语音说「急停」任何时候立即 `$DST!`（旁路直达，不经网络）。

## 固件指令协议（来源：机械臂项目 `app_servo.c`）

```
$DGS:x!        执行第 x 组动作        $DGT:x-y,z!   循环第 x~y 组 z 次
$KMS:x,y,z,t!  运动学移动 (x,y,z) t毫秒  $DST!         全停（急停）
$DJR!          全部回中               $BEEP!        蜂鸣
```

注意：机械臂固件 `main.c` while(1) 里的 `kinematics_move` 演示代码会周期抢控制权，联调前删掉。

## 文字指令 → 硬件，在哪里？

链路一句话：**识别文字 → `commands.js` 变成固件协议字符串 → `serial.js` 写进串口 → 机械臂**。

| 环节 | 文件 | 职责 |
|---|---|---|
| 指令映射/校验 | `src/main/commands.js` | **核心**。急停热词表、快速规则（正则）、LLM 工具定义、参数校验（越界拒绝执行）、`toSerial()` 把指令翻译成固件协议串（`$DGS:3!` / `$KMS:0,200,250,1000!` / `$DST!`…） |
| 硬件出口 | `src/renderer/serial.js` | Web Serial 打开 USB-TTL 串口（115200 8N1），把字符串写给机械臂 USART1；回显（"A"、"@Group Done"）读回日志 |
| 编排调度 | `src/main/ipc-handlers.js` | `handleText()`：急停旁路 → 快速规则 → 云 LLM，产出的指令经 `sendSerial()` 推给渲染进程写出 |

想改口令→指令的映射，只动 `commands.js`（规则表 + 工具定义）；想换通信方式（BLE/网络），只动 `serial.js`。

## 目录结构

```
arm-control/
├── electron.vite.config.mjs      构建配置（dev 端口固定 5321，避开 5173 冲突）
├── package.json                  依赖：sherpa-onnx-node + electron（electron-vite 构建）
├── models -> ../MiniChat/models      语音模型软链接（VAD/ASR/TTS 约 1.2G，复用 MiniChat）
├── scripts/download-models.mjs   模型下载脚本（脱离 MiniChat 单独部署时用）
├── src/
│   ├── main/                     Electron 主进程
│   │   ├── index.js              窗口创建 + Web Serial 权限放行（select-serial-port）
│   │   ├── config.js             配置读写（ASR / 云 LLM / 串口波特率），.env.local 兜底
│   │   ├── ipc-handlers.js       ★ 编排：音频 → VAD → ASR → 指令 → 串口
│   │   ├── commands.js           ★ 文字→硬件指令：热词/规则/LLM工具/校验/串口协议映射
│   │   ├── llm.js                云 LLM function calling（OpenAI 兼容，口语→结构化动作）
│   │   ├── asr.js                ASR 调度：微软 Azure ↔ 本地 SenseVoice 兜底
│   │   ├── asr-azure.js          微软 Azure Speech REST（WAV 编码 + 短语音识别）
│   │   └── audio-engine.js       语音引擎（MiniChat 原样复用：Silero VAD / SenseVoice / VITS TTS）
│   ├── preload/index.js          IPC 桥（contextBridge 暴露 window.api）
│   └── renderer/                 Electron 渲染进程
│       ├── index.html            控制台页面（急停/按住说话/免按键/日志/设置）
│       ├── app.js                UI 逻辑与状态机
│       ├── serial.js             ★ 硬件出口：Web Serial 写指令到机械臂 USART1
│       ├── recorder.js           麦克风 16kHz 采集（getUserMedia → IPC）
│       └── styles.css            样式
└── README.md
```

数据流全景：

```
麦克风(recorder.js) → IPC → VAD+ASR(audio-engine/asr*.js) → 文字
  → handleText(ipc-handlers.js)
      ├─ 急停热词 ──────────→ $DST!（旁路）
      ├─ 快速规则(commands.js)→ 固定指令（零延时）
      └─ 云 LLM(llm.js) ────→ 工具调用 → 校验(commands.js)
            → serial:write IPC → serial.js → USB-TTL → 机械臂 USART1
```

## 迁移与自定义（后期换口令 / 换硬件）

三个"换"都只动一两个文件，链路其他部分不用碰。

### ① 换语音指令（口令 → 动作）

全在 `src/main/commands.js`：

1. **急停热词**：`STOP_KEYWORDS` 数组加词（如"快停"）。热词永远旁路直达 `$DST!`，不过 LLM。
2. **固定口令**：`matchQuickCommand()` 规则表加一行 `{ re, label, command, speak }`——匹配即执行，零延时零成本。例：`/^(?:挥手|招手)$/` → `{ type: 'run_group', id: 7 }`。
3. **口语化/复杂指令**：走 LLM 的两处**同步**改——`commands.js` 的 `TOOL_DEFINITIONS`（工具名/参数/枚举）+ `src/main/llm.js` 的 `SYSTEM_PROMPT`（场景话术、默认参数、反问规则）。
4. **反馈话术**：`describe()`（日志/TX 标签）与各规则的 `speak` 字段。

改完口令表，把本 README 和界面「操作说明」（`src/renderer/index.html` 的 `.manual-body`）速查表同步一下。

### ② 换硬件操作（动作 → 机器指令）

1. **协议映射**：`toSerial(command)`——结构化指令翻译成目标硬件的字节协议。机械臂是 `$DGS:3!` 这套；换成灯/云台/小车就在这里输出它们的协议。
2. **参数边界**：`validate()` 的 clamp/范围（坐标 mm、动作组 0-200、耗时 100-10000ms）——按新硬件安全范围改，越界仍拒绝执行。
3. **物理通道**：`src/renderer/serial.js` 只做「连接 / 写指令 / 读回显」三件事——换 BLE/网络透传只替换这个文件的 `connect()`/`write()`，主进程编排（`ipc-handlers.js`）不动。
4. **波特率**：`.env.local` / `config.json` 的 `serialBaud`。

### ③ 换/加语音引擎、ASR、LLM

- **ASR 后端**：`src/main/asr.js`（调度）+ `asr-azure.js`（微软）。新后端照 `recognize(float32Samples)` 签名加一个文件即可；未配置自动回退本地 SenseVoice。
- **VAD / 离线识别 / TTS**：`src/main/audio-engine.js`（sherpa-onnx）。
- **LLM**：任意 OpenAI 兼容端点，`.env.local` 三行 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 即换。

### 迁移到形态二（手机壳 / PWA）

`commands.js`（映射/校验）与 `llm.js`、`asr*.js`（解析）原样搬进转发层服务；壳子只留收音 + 按钮 + WebSocket。串口出口换成转发层到硬件的通道（BLE / 局域网透传）。

## 路线图（形态二）

壳子换成手机 PWA（收音 + 按钮），语音引擎与指令层抽成独立转发层服务，手机经 WebSocket 连转发层，转发层接机械臂——手机拿在手上遥控。
