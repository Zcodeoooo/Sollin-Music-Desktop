#!/usr/bin/env node
// End-to-end regression test for "exclusive playback stops when the window is
// minimised".
//
// Reproduces the engine's data path inside a real renderer: the page opens an
// exclusive stream through the production preload/IPC, starts the playback and
// feeds PCM from a setInterval pump (exactly like src/services/wasapiExclusive),
// with the background-throttling opt-out applied.  The window is then minimised
// and the playback clock must keep advancing.
//
//   ELECTRON_RUN_AS_NODE= node_modules\.bin\electron native/wasapi-exclusive/test/minimized-playback.js
'use strict'

const { app, BrowserWindow } = require('electron')
const path = require('path')

const root = path.join(__dirname, '..', '..', '..')
require(path.join(root, 'dist-electron', 'wasapiOutput.js')).setupWasapiOutputIpc()

const PAGE = `<!doctype html><html><body><script>
const state = { running: false, written: 0, rate: 48000, channels: 2, pump: null }

window.startPlayback = async (disableThrottling) => {
  const api = window.electronAPI
  const devices = await api.wasapiListDevices()
  if (!devices.ok || !devices.value.devices.length) throw new Error('no endpoints')
  const device = devices.value.devices.find((entry) => entry.isDefault) || devices.value.devices[0]

  const opened = await api.wasapiOpen({
    deviceId: device.id,
    sampleRate: 48000,
    channels: 2,
    formats: [
      { bits: 24, validBits: 24, isFloat: false },
      { bits: 32, validBits: 24, isFloat: false },
      { bits: 16, validBits: 16, isFloat: false },
    ],
    bufferMs: 100,
    ringSeconds: 2,
  })
  if (!opened.ok) throw new Error(opened.message)

  if (disableThrottling) {
    const result = await api.wasapiSetBackgroundThrottling(true)
    if (!result.ok) throw new Error(result.message)
  }

  const rate = opened.value.format.sampleRate
  const channels = opened.value.format.channels
  state.rate = rate
  state.channels = channels

  const chunkFrames = 1024
  const pcm = new Float32Array(chunkFrames * channels)
  for (let frame = 0; frame < chunkFrames; frame += 1) {
    const value = Math.sin((2 * Math.PI * 440 * frame) / rate) * 0.1
    for (let channel = 0; channel < channels; channel += 1) {
      pcm[frame * channels + channel] = value
    }
  }

  // Pre-roll half a second, then start.
  let written = 0
  while (written < rate * 0.5) {
    const result = await api.wasapiWrite(pcm)
    if (!result.ok) throw new Error(result.message)
    written += result.value.accepted
  }
  await api.wasapiControl('resume')
  state.written = written
  state.running = true

  state.pump = setInterval(async () => {
    if (!state.running) return
    const status = await api.wasapiStatus()
    if (!status.ok || !status.value.open) return
    const capacity = status.value.ringCapacityFrames || 0
    let free = capacity - (status.value.bufferedFrames || 0)
    let guard = 0
    // Mirror the engine: top the ring up completely on every tick.
    while (free > 0 && guard < 16) {
      guard += 1
      const frames = Math.min(chunkFrames, free)
      const result = await api.wasapiWrite(pcm.subarray(0, frames * channels))
      if (!result.ok) break
      state.written += result.value.accepted
      free -= result.value.accepted
      if (result.value.starved) await api.wasapiControl('resume')
      if (result.value.accepted === 0) break
    }
  }, 40)

  return { rate, channels, deviceName: opened.value.deviceName || device.name }
}

window.stopPlayback = async () => {
  state.running = false
  if (state.pump) clearInterval(state.pump)
  await window.electronAPI.wasapiSetBackgroundThrottling(false)
  await window.electronAPI.wasapiClose()
}

window.readPosition = async () => {
  const status = await window.electronAPI.wasapiStatus()
  return status.ok ? (status.value.positionFrames || 0) : -1
}
</script></body></html>`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  app.disableHardwareAcceleration()
  await app.whenReady()

  const win = new BrowserWindow({
    width: 480,
    height: 320,
    show: true,
    webPreferences: {
      preload: path.join(root, 'dist-electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
    },
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
  await sleep(600)

  const evalJs = (expression) => win.webContents.executeJavaScript(expression)
  const started = await evalJs('window.startPlayback(true)')
  console.log('[minimized] stream:', JSON.stringify(started))
  await sleep(700)

  win.minimize()
  const before = await evalJs('window.readPosition()')
  const startedAt = Date.now()
  await sleep(4000)
  const after = await evalJs('window.readPosition()')
  const elapsed = (Date.now() - startedAt) / 1000
  win.restore()

  const deltaFrames = after - before
  const deltaSeconds = deltaFrames / started.rate
  console.log('[minimized] before:', before, 'after:', after,
    `delta ${deltaSeconds.toFixed(2)}s over ${elapsed.toFixed(2)}s wall clock`)

  await evalJs('window.stopPlayback()')
  win.destroy()

  // The pump keeps the ring full, so the device clock must track wall time.
  if (deltaSeconds < elapsed * 0.85) {
    console.error('[minimized] FAIL: playback stalled while minimised')
    app.exit(1)
    return
  }
  console.log('[minimized] OK')
  app.exit(0)
}

main().catch((error) => {
  console.error('[minimized] failed:', error)
  app.exit(1)
})
