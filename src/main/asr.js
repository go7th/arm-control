/**
 * ASR 调度：微软 Azure（默认）↔ 本地 sherpa-onnx SenseVoice（兜底）
 *
 * VAD 切句和 TTS 播报仍走本地 sherpa-onnx，与 ASR 后端无关。
 */
import { recognizeAudio } from './audio-engine.js'
import { recognizeWithAzure } from './asr-azure.js'
import { getConfig } from './config.js'

let warnedAzureFallback = false

export async function recognize(float32Samples) {
  const { provider, azure } = getConfig().asr || {}

  if (provider === 'azure') {
    if (azure?.key && azure?.region) {
      try {
        return await recognizeWithAzure(float32Samples, azure)
      } catch (e) {
        console.error('[ASR] Azure failed, fallback to local:', e.message)
        // Azure 失败不打断流程：回退本地识别
      }
    } else if (!warnedAzureFallback) {
      warnedAzureFallback = true
      console.warn('[ASR] Azure 未配置 key/region，使用本地识别')
    }
  }

  return recognizeAudio(float32Samples)
}
