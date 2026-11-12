#!/usr/bin/env node
// Verifies that an exclusive stream parks itself when the producer runs dry and
// resumes exactly where the audio content stopped.
//
// Rationale: the renderer feeds the endpoint from a timer.  When Chromium
// throttles that timer (window minimised) the ring empties.  Padding silence
// keeps the device clock running ahead of the audible samples; parking the
// stream freezes IAudioClock on the content position instead, so progress and
// lyrics stay accurate and the next write resumes without a gap in the timeline.
//
//   node native/wasapi-exclusive/test/starvation.js
'use strict'

const path = require('path')
const loader = require(path.join(__dirname, '..', 'index.js'))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function buildTone(rate, channels, frames, startFrame) {
  const pcm = new Float32Array(frames * channels)
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.sin((2 * Math.PI * 440 * (startFrame + frame)) / rate) * 0.2
    for (let channel = 0; channel < channels; channel += 1) {
      pcm[frame * channels + channel] = value
    }
  }
  return pcm
}

async function main() {
  if (!loader.addon) {
    console.error('[starve] addon unavailable:', loader.error)
    process.exit(1)
  }
  const addon = loader.addon

  const devices = addon.listDevices()
  if (devices.length === 0) {
    console.error('[starve] no audio endpoints')
    process.exit(2)
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
    ringSeconds: 1,
  })

  const rate = opened.format.sampleRate
  const channels = opened.format.channels
  const chunkFrames = Math.round(rate * 0.2)

  const first = addon.write(buildTone(rate, channels, chunkFrames, 0))
  addon.resume()
  console.log('[starve] first chunk accepted:', first.accepted, 'format:', JSON.stringify(opened.format))

  // Let the chunk play out and the producer stay silent.
  await sleep(800)
  const parked = addon.status()
  const parkedPosition = parked.positionFrames ?? 0
  console.log('[starve] after draining:', JSON.stringify({
    starved: parked.starved,
    playing: parked.playing,
    positionFrames: parkedPosition,
    bufferedFrames: parked.bufferedFrames,
    silenceFrames: parked.silenceFrames,
    debug: parked.debug,
  }))

  let failures = 0
  const check = (name, ok, detail) => {
    if (ok) {
      console.log('[starve] ok  ', name)
    } else {
      failures += 1
      console.error('[starve] FAIL', name, detail === undefined ? '' : JSON.stringify(detail))
    }
  }

  check('stream parked itself', parked.starved === true, parked.starved)
  check('clock froze on the content position', Math.abs(parkedPosition - first.accepted) <= rate * 0.05, {
    positionFrames: parkedPosition,
    writtenFrames: first.accepted,
  })
  check('ring is empty', (parked.bufferedFrames ?? 0) === 0, parked.bufferedFrames)

  // Feed more data: the stream must continue from the frozen position.
  const second = addon.write(buildTone(rate, channels, chunkFrames, chunkFrames))
  addon.resume()
  await sleep(80)
  const resumed = addon.status()
  const resumedPosition = resumed.positionFrames ?? 0
  console.log('[starve] after resume:', JSON.stringify({
    starved: resumed.starved,
    playing: resumed.playing,
    positionFrames: resumedPosition,
    bufferedFrames: resumed.bufferedFrames,
  }))

  check('second chunk accepted', second.accepted === chunkFrames, second)
  check('stream resumed', resumed.starved !== true, resumed.starved)
  check(
    'position continued from the frozen point',
    resumedPosition > parkedPosition && resumedPosition <= parkedPosition + chunkFrames,
    { parkedPosition, resumedPosition },
  )

  // Once the second chunk is exhausted the stream parks again, one chunk after.
  await sleep(700)
  const final = addon.status()
  const finalPosition = final.positionFrames ?? 0
  console.log('[starve] final:', JSON.stringify({
    starved: final.starved,
    positionFrames: finalPosition,
  }))
  check(
    'no audio lost across park/resume',
    Math.abs(finalPosition - (first.accepted + second.accepted)) <= rate * 0.05,
    { finalPosition, expected: first.accepted + second.accepted },
  )

  addon.close()
  if (failures > 0) {
    console.error(`[starve] ${failures} failure(s)`)
    process.exit(1)
  }
  console.log('[starve] OK')
}

main().catch((error) => {
  console.error('[starve] failed:', error)
  process.exit(1)
})
