#!/usr/bin/env node
// Manual smoke test for the WASAPI exclusive addon.
//
//   node native/wasapi-exclusive/test/smoke.js [--device <id>] [--rate 48000] [--bits 24]
//
// Plays a short 440 Hz tone through the endpoint in exclusive mode, verifies
// that the playback clock advances in real time, then exercises pause / resume /
// seek / volume.  Requires real audio hardware.
'use strict'

const path = require('path')
const loader = require(path.join(__dirname, '..', 'index.js'))

function log(...args) {
  console.log('[smoke]', ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseArgs(argv) {
  const options = { device: null, rate: 48000, bits: 24, seconds: 2 }
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--device') options.device = value
    if (key === '--rate') options.rate = Number(value)
    if (key === '--bits') options.bits = Number(value)
    if (key === '--seconds') options.seconds = Number(value)
  }
  return options
}

function summarize(status, rate) {
  const debug = status.debug || {}
  return `pos=${(status.positionFrames / rate).toFixed(3)}s ` +
    `buf=${status.bufferedFrames}/${status.ringCapacityFrames} ` +
    `playing=${status.playing} events=${debug.events} fills=${debug.fills} ` +
    `padding=${debug.padding} avail=${debug.available} ` +
    `hr=${debug.lastHResult != null ? ('0x' + (debug.lastHResult >>> 0).toString(16)) : '?'} ` +
    `err=${debug.errors}`
}

async function main() {
  if (!loader.addon) {
    console.error('[smoke] addon unavailable:', loader.error)
    process.exit(1)
  }
  const addon = loader.addon
  log('addon loaded from', loader.path)
  log('isAvailable:', addon.isAvailable())

  const devices = addon.listDevices()
  if (devices.length === 0) {
    console.error('[smoke] no active render endpoints on this machine')
    process.exit(2)
  }
  for (const device of devices) {
    log(`device ${device.isDefault ? '*' : ' '} ${device.name}  ${device.id}`)
  }

  const options = parseArgs(process.argv)
  const device = options.device
    ? devices.find((entry) => entry.id === options.device)
    : devices.find((entry) => entry.isDefault) || devices[0]
  if (!device) {
    console.error('[smoke] device not found')
    process.exit(2)
  }

  const probe = addon.probeFormats(device.id, 2)
  for (const rateEntry of probe.sampleRates) {
    const formats = rateEntry.formats
      .map((format) => `${format.validBits}${format.isFloat ? 'f' : 'i'}/${format.bits}`)
      .join(', ')
    log(`probe ${rateEntry.sampleRate} Hz -> ${formats}`)
  }

  const formats = options.bits === 16
    ? [{ bits: 16, validBits: 16, isFloat: false }, { bits: 24, validBits: 24, isFloat: false }]
    : [{ bits: 24, validBits: 24, isFloat: false }, { bits: 32, validBits: 24, isFloat: false },
      { bits: 16, validBits: 16, isFloat: false }]

  log('opening', device.name, 'at', options.rate, 'Hz', 'formats', JSON.stringify(formats))
  const opened = addon.open({
    deviceId: device.id,
    sampleRate: options.rate,
    channels: 2,
    formats,
    bufferMs: 100,
  })
  log('opened:', JSON.stringify(opened))

  const channels = opened.format.channels
  const rate = opened.format.sampleRate
  const frameCount = Math.round(rate * options.seconds)

  let written = 0
  let phase = 0
  const writeChunk = (frames) => {
    const pcm = new Float32Array(frames * channels)
    for (let frame = 0; frame < frames; frame += 1) {
      const value = Math.sin(phase) * 0.2
      phase += (2 * Math.PI * 440) / rate
      for (let channel = 0; channel < channels; channel += 1) {
        pcm[frame * channels + channel] = value
      }
    }
    const result = addon.write(pcm)
    written += result.accepted
    return result
  }

  writeChunk(Math.min(frameCount, opened.deviceBufferFrames * 2))
  addon.resume()
  log('started; pre-rolled', written, 'frames, device buffer', opened.deviceBufferFrames)

  const startedAt = Date.now()
  let lastLog = startedAt
  let lastPosition = 0
  const hardDeadline = startedAt + (options.seconds + 6) * 1000

  while (Date.now() < hardDeadline) {
    const status = addon.status()
    lastPosition = status.positionFrames
    if (status.positionFrames >= frameCount) break

    const free = status.ringCapacityFrames - status.bufferedFrames
    if (free > 0 && written < frameCount) {
      writeChunk(Math.min(frameCount - written, free, 2048))
    }

    if (Date.now() - lastLog > 500) {
      log(`t=${((Date.now() - startedAt) / 1000).toFixed(2)}s ` + summarize(status, rate))
      lastLog = Date.now()
    }
    await sleep(20)
  }

  const playedSeconds = lastPosition / rate
  const wallSeconds = (Date.now() - startedAt) / 1000
  log(`played ${playedSeconds.toFixed(3)}s of audio in ${wallSeconds.toFixed(3)}s wall clock`)
  log('final:', summarize(addon.status(), rate))

  if (playedSeconds < options.seconds * 0.8) {
    console.error('[smoke] FAIL: the playback position did not advance')
    addon.close()
    process.exit(3)
  }

  addon.pause()
  const pausedA = addon.status().positionFrames
  await sleep(400)
  const pausedB = addon.status().positionFrames
  log(`pause check: ${pausedA} -> ${pausedB}`)
  if (Math.abs(pausedB - pausedA) > rate * 0.05) {
    console.error('[smoke] FAIL: position moved while paused')
  }

  addon.setVolume(0.35, false)
  log('volume after set:', JSON.stringify(addon.getVolume()))
  addon.setVolume(1.0, false)

  addon.resume()
  await sleep(300)
  const resumed = addon.status().positionFrames
  log(`resume check: ${pausedB} -> ${resumed}`)
  if (resumed <= pausedB) {
    console.error('[smoke] FAIL: position did not advance after resume')
  }

  addon.reset()
  await sleep(120)
  const afterReset = addon.status().positionFrames
  log(`reset check: position=${afterReset}`)
  if (afterReset > rate * 0.25) {
    console.error('[smoke] FAIL: position did not rewind after reset')
  }

  addon.close()
  log('OK')
}

main().catch((error) => {
  console.error('[smoke] failed:', error)
  process.exit(1)
})
