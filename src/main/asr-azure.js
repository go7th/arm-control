/**
 * 微软 Azure Speech —— 语音转文字（REST 短语音接口）
 *
 * 我们的音频都是"整句"（VAD 切好 / 按住说话拼好），正好用短语音 REST：
 *   POST https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
 *        ?language=zh-CN&format=simple
 *   Header: Ocp-Apim-Subscription-Key
 *   Body:   WAV (16kHz / 16bit / mono PCM)
 *   返回:   { RecognitionStatus, DisplayText }
 */

// Float32 [-1,1] 16kHz mono → WAV 字节
function encodeWav(float32Samples, sampleRate = 16000) {
  const pcm = new Int16Array(float32Samples.length)
  for (let i = 0; i < float32Samples.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const dataSize = pcm.length * 2
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)        // fmt chunk size
  view.setUint16(20, 1, true)         // PCM
  view.setUint16(22, 1, true)         // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true)         // block align
  view.setUint16(34, 16, true)        // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  new Int16Array(buf, 44).set(pcm)
  return new Uint8Array(buf)
}

/**
 * @returns {Promise<string>} 识别出的文字（无匹配返回 ''）
 * 失败抛错（由上层记日志/回退）
 */
export async function recognizeWithAzure(float32Samples, azureConfig) {
  const { key, region, language = 'zh-CN', endpoint } = azureConfig || {}
  if (!key || !region) {
    throw new Error('Azure ASR 未配置（需要 key 和 region）')
  }

  const base = endpoint
    || `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`
  const url = `${base}?language=${encodeURIComponent(language)}&format=simple`

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
      'Accept': 'application/json'
    },
    body: encodeWav(float32Samples),
    signal: AbortSignal.timeout(15000)
  })

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`Azure ASR ${resp.status}: ${detail.slice(0, 160)}`)
  }

  const data = await resp.json()
  if (data.RecognitionStatus !== 'Success') {
    return '' // NoMatch / InitialSilenceTimeout 等：当作没听清
  }
  return (data.DisplayText || '').trim()
}
