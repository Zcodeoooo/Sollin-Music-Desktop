#!/usr/bin/env node
// Verifies that the WASAPI addon loads inside the Electron main process (ABI
// check for the packaged application).
//
//   npx electron native/wasapi-exclusive/test/electron-load.js
'use strict'

const path = require('path')

function log(...args) {
  console.log('[electron-smoke]', ...args)
}

async function main() {
  const { app } = require('electron')
  app.disableHardwareAcceleration()

  await app.whenReady()

  const loader = require(path.join(__dirname, '..', 'index.js'))
  log('electron', process.versions.electron, 'node', process.versions.node)
  log('addon loaded:', Boolean(loader.addon), loader.error || '')

  if (!loader.addon) {
    app.exit(1)
    return
  }

  const addon = loader.addon
  const devices = addon.listDevices()
  log('devices:', devices.map((device) => `${device.name}${device.isDefault ? ' (default)' : ''}`))
  if (devices.length === 0) {
    app.exit(2)
    return
  }

  const device = devices.find((entry) => entry.isDefault) || devices[0]
  const opened = addon.open({
    deviceId: device.id,
    sampleRate: 48000,
    channels: 2,
    formats: [
      { bits: 24, validBits: 24, isFloat: false },
      { bits: 32, validBits: 24, isFloat: false },
      { bits: 16, validBits: 16, isFloat: false },
    ],
    bufferMs: 100,
  })
  log('opened:', JSON.stringify(opened.format), 'buffer frames', opened.deviceBufferFrames)

  const frames = opened.deviceBufferFrames * 2
  const pcm = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i += 1) {
    const value = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.1
    pcm[i * 2] = value
    pcm[i * 2 + 1] = value
  }
  const result = addon.write(pcm)
  log('wrote frames:', result.accepted, 'buffered:', result.buffered)
  addon.resume()
  await new Promise((resolve) => setTimeout(resolve, 400))
  const status = addon.status()
  log('position frames:', status.positionFrames, 'playing:', status.playing)
  addon.close()

  if (status.positionFrames <= 0) {
    log('FAIL: no playback progress')
    app.exit(3)
    return
  }
  log('OK')
  app.exit(0)
}

main().catch((error) => {
  console.error('[electron-smoke] failed:', error)
  process.exit(1)
})
