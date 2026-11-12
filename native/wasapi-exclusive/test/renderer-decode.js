#!/usr/bin/env node
// Verifies the renderer-side decoding assumptions of the bit-perfect path:
//
//   1. decodeAudioData() honours the OfflineAudioContext sample rate: a file
//      decoded in a context with the same rate keeps its frame count (no
//      resampling), and a different context rate resamples it.
//   2. The output always carries the context's sample rate, which is why the
//      engine must create the context at the file's native rate.
//
// Sample-level exactness (and the integer normalization compensation) is
// covered by decode-mapping.js and pcm-normalization.js.
//
//   set ELECTRON_RUN_AS_NODE= (empty) before running:
//   node_modules\.bin\electron native/wasapi-exclusive/test/renderer-decode.js
'use strict'

const { app, BrowserWindow } = require('electron')

const PAGE = `<!doctype html><html><body><script>
function makeWav(sampleRate, channels, frames) {
  const blockAlign = channels * 2
  const dataSize = frames * blockAlign
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
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)
  let offset = 44
  for (let i = 0; i < frames * channels; i += 1) {
    const value = ((i * 37) % 65536) - 32768
    view.setInt16(offset, value, true)
    offset += 2
  }
  return buffer
}

async function decodeAt(fileRate, contextRate, frames) {
  const buffer = makeWav(fileRate, 2, frames)
  const context = new OfflineAudioContext(2, 1, contextRate)
  const decoded = await context.decodeAudioData(buffer.slice(0))
  return {
    fileRate,
    contextRate,
    decodedRate: decoded.sampleRate,
    decodedChannels: decoded.numberOfChannels,
    fileFrames: frames,
    decodedFrames: decoded.length,
  }
}

window.runTest = async () => {
  const frames = Math.round(44100 * 0.4)
  return {
    sameRate: await decodeAt(44100, 44100, frames),
    upsampled: await decodeAt(44100, 48000, frames),
    downsampled: await decodeAt(44100, 22050, frames),
  }
}
</script></body></html>`

async function main() {
  app.disableHardwareAcceleration()
  await app.whenReady()

  console.log('[decode-test] electron', process.versions.electron, 'node', process.versions.node)

  const win = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
  const result = await win.webContents.executeJavaScript('window.runTest()')

  for (const [name, entry] of Object.entries(result)) {
    console.log(`[decode-test] ${name}:`, JSON.stringify(entry))
  }

  const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance
  let failures = 0
  const check = (name, ok, detail) => {
    if (!ok) {
      failures += 1
      console.error(`[decode-test] FAIL ${name}:`, detail)
    }
  }

  check(
    'same rate keeps the frame count',
    result.sameRate.decodedRate === 44100 && result.sameRate.decodedFrames === result.sameRate.fileFrames,
    result.sameRate,
  )
  check(
    'upsampling produces 48k frames',
    result.upsampled.decodedRate === 48000
      && near(result.upsampled.decodedFrames, result.upsampled.fileFrames * (48000 / 44100), 2),
    result.upsampled,
  )
  check(
    'downsampling produces 22k frames',
    result.downsampled.decodedRate === 22050
      && near(result.downsampled.decodedFrames, result.downsampled.fileFrames / 2, 2),
    result.downsampled,
  )
  check('channel count preserved', result.sameRate.decodedChannels === 2, result.sameRate)

  win.destroy()
  console.log(failures === 0 ? '[decode-test] OK' : `[decode-test] ${failures} failure(s)`)
  app.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[decode-test] failed:', error)
  app.exit(1)
})
