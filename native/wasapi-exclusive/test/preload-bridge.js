#!/usr/bin/env node
// Verifies the real preload bridge + main-process IPC + native addon in one go.
// Uses dist-electron/preload.js (the same file the application loads) and the
// production wasapiOutput IPC handlers.
//
//   node native/wasapi-exclusive/test/preload-bridge.js
'use strict'

const { app, BrowserWindow } = require('electron')
const path = require('path')

const root = path.join(__dirname, '..', '..', '..')
require(path.join(root, 'dist-electron', 'wasapiOutput.js')).setupWasapiOutputIpc()

async function main() {
  await app.whenReady()

  const win = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: {
      preload: path.join(root, 'dist-electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const pageError = []
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    pageError.push(`${preloadPath}: ${error.message}`)
  })

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body>bridge</body></html>'))

  const result = await win.webContents.executeJavaScript(`(async () => {
    const api = window.electronAPI
    if (!api) return { error: 'window.electronAPI is undefined' }
    if (typeof api.wasapiListDevices !== 'function') return { error: 'wasapiListDevices missing', keys: Object.keys(api).length }
    const devices = await api.wasapiListDevices()
    if (!devices.ok) return { error: 'listDevices failed: ' + devices.message }
    const list = devices.value.devices || []
    if (list.length === 0) return { error: 'no endpoints', supported: devices.value.supported, message: devices.value.error }
    const device = list.find((entry) => entry.isDefault) || list[0]
    const opened = await api.wasapiOpen({
      deviceId: device.id,
      sampleRate: 48000,
      channels: 2,
      formats: [
        { bits: 24, validBits: 24, isFloat: false },
        { bits: 16, validBits: 16, isFloat: false },
      ],
      bufferMs: 100,
    })
    if (!opened.ok) return { error: 'open failed: ' + opened.message, code: opened.code }
    const frames = opened.value.deviceBufferFrames || 4800
    const pcm = new Float32Array(frames * 2)
    for (let i = 0; i < frames; i += 1) {
      const value = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.1
      pcm[i * 2] = value
      pcm[i * 2 + 1] = value
    }
    const written = await api.wasapiWrite(pcm)
    const resume = await api.wasapiControl('resume')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const status = await api.wasapiStatus()
    await api.wasapiClose()
    return {
      deviceCount: list.length,
      deviceName: device.name,
      format: opened.value.format,
      accepted: written.ok ? written.value.accepted : null,
      resumed: resume.ok,
      positionFrames: status.ok ? status.value.positionFrames : null,
    }
  })()`)

  console.log('[bridge] result:', JSON.stringify(result))
  if (pageError.length > 0) console.error('[bridge] preload errors:', pageError)

  const ok = result && !result.error && result.positionFrames > 0
  console.log(ok ? '[bridge] OK' : '[bridge] FAIL')
  win.destroy()
  app.exit(ok ? 0 : 1)
}

main().catch((error) => {
  console.error('[bridge] failed:', error)
  app.exit(1)
})
