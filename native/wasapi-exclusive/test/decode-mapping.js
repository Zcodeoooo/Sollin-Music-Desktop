#!/usr/bin/env node
// Measures Chromium's integer PCM -> float normalization exhaustively.
//
// Measured on Electron 43 (Chromium):
//   16 bit integer PCM:  v >= 0 -> f = v / 32767,  v < 0 -> f = v / 32768
//                        (asymmetric; multiplying by 32768 is off by one LSB for
//                        roughly half of all samples)
//   24 bit integer PCM:  f = v / 2^23 in both polarities (exact)
//
// The renderer compensates for the asymmetric case so the original integer
// samples reach the endpoint unchanged (see src/services/pcmNormalization.ts).
//
//   ELECTRON_RUN_AS_NODE= node_modules\.bin\electron native/wasapi-exclusive/test/decode-mapping.js
'use strict'

const { app, BrowserWindow } = require('electron')

const PAGE = `<!doctype html><html><body><script>
function makeWav(sampleRate, channels, bitsPerSample, samples) {
  const bytesPerSample = bitsPerSample / 8
  const blockAlign = channels * bytesPerSample
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)
  let offset = 44
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i]
    if (bitsPerSample === 16) {
      view.setInt16(offset, value, true)
      offset += 2
    } else {
      view.setUint8(offset, value & 0xff)
      view.setUint8(offset + 1, (value >> 8) & 0xff)
      view.setUint8(offset + 2, (value >> 16) & 0xff)
      offset += 3
    }
  }
  return buffer
}

async function measure(bits, samples, sampleRate) {
  const buffer = makeWav(sampleRate, 1, bits, samples)
  const context = new OfflineAudioContext(1, 1, sampleRate)
  const decoded = await context.decodeAudioData(buffer.slice(0))
  const data = decoded.getChannelData(0)
  const half = Math.pow(2, bits - 1)

  let positives = 0
  let negatives = 0
  let positiveMatchesHalf = 0
  let positiveMatchesHalfMinusOne = 0
  let negativeMatchesHalf = 0

  for (let i = 0; i < samples.length; i += 1) {
    const original = samples[i]
    const value = data[i]
    if (original >= 0) {
      positives += 1
      if (Math.round(value * half) === original) positiveMatchesHalf += 1
      if (Math.round(value * (half - 1)) === original) positiveMatchesHalfMinusOne += 1
    } else {
      negatives += 1
      if (Math.round(value * half) === original) negativeMatchesHalf += 1
    }
  }

  return {
    bits,
    sampleRate,
    reportedRate: decoded.sampleRate,
    frames: decoded.length,
    positives,
    negatives,
    positiveMatchesHalf,
    positiveMatchesHalfMinusOne,
    negativeMatchesHalf,
  }
}

window.runTest = async () => {
  const all16 = new Int32Array(65536)
  for (let i = 0; i < 65536; i += 1) all16[i] = i - 32768

  const half24 = 8388608
  const steps = 40000
  const sweep24 = new Int32Array(steps)
  for (let i = 0; i < steps; i += 1) {
    const value = Math.round(((i * 2654435761) % 4294967296) / 4294967296 * (half24 * 2)) - half24
    sweep24[i] = Math.max(-half24, Math.min(half24 - 1, value))
  }

  return {
    wav16: await measure(16, all16, 44100),
    wav24: await measure(24, sweep24, 96000),
  }
}
</script></body></html>`

async function main() {
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
  const result = await win.webContents.executeJavaScript('window.runTest()')

  const entry16 = result.wav16
  const entry24 = result.wav24
  console.log('[mapping] 16 bit:', JSON.stringify(entry16))
  console.log('[mapping] 24 bit:', JSON.stringify(entry24))

  let failures = 0
  const check = (name, ok, detail) => {
    if (ok) {
      console.log(`[mapping] ok   ${name}`)
    } else {
      failures += 1
      console.error(`[mapping] FAIL ${name}:`, JSON.stringify(detail))
    }
  }

  // 16 bit: positive samples must follow /32767 and must NOT follow /32768;
  // negative samples follow /32768 in both models.
  check('16 bit positives use 2^15-1', entry16.positiveMatchesHalfMinusOne === entry16.positives, entry16)
  check('16 bit positives are not symmetric', entry16.positiveMatchesHalf < entry16.positives, entry16)
  check('16 bit negatives use 2^15', entry16.negativeMatchesHalf === entry16.negatives, entry16)

  // 24 bit: symmetric.
  check('24 bit positives are symmetric', entry24.positiveMatchesHalf === entry24.positives, entry24)
  check('24 bit negatives are symmetric', entry24.negativeMatchesHalf === entry24.negatives, entry24)

  win.destroy()
  console.log(failures === 0
    ? '[mapping] OK: 16 bit asymmetric / 24 bit symmetric normalization confirmed'
    : `[mapping] ${failures} failure(s)`)
  app.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[mapping] failed:', error)
  app.exit(1)
})
