#!/usr/bin/env node
// Unit test for the container probe used to find the file's native sample rate.
// Builds synthetic headers for the supported containers and checks the probe.
'use strict'

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(__dirname, '..', '..', '..')
const sourceFile = path.join(root, 'src', 'services', 'audioFormatProbe.ts')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sollin-probe-'))

execFileSync(process.execPath, [
  path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  sourceFile,
  '--outDir', outDir,
  '--module', 'commonjs',
  '--target', 'es2020',
  '--skipLibCheck',
], { stdio: 'inherit' })

// eslint-disable-next-line import/no-dynamic-require
const { probeAudioFormat } = require(path.join(outDir, 'audioFormatProbe.js'))

let failures = 0
function check(name, actual, expected) {
  const ok = Object.keys(expected).every((key) => expected[key] === actual[key])
  if (ok) {
    console.log(`[probe] ok   ${name}`, JSON.stringify(actual))
  } else {
    failures += 1
    console.error(`[probe] FAIL ${name}: expected`, JSON.stringify(expected), 'got', JSON.stringify(actual))
  }
}

function writeAscii(bytes, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index)
  }
}

function u16le(bytes, offset, value) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >> 8) & 0xff
}

function u32le(bytes, offset, value) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >> 8) & 0xff
  bytes[offset + 2] = (value >> 16) & 0xff
  bytes[offset + 3] = (value >> 24) & 0xff
}

function u32be(bytes, offset, value) {
  bytes[offset] = (value >> 24) & 0xff
  bytes[offset + 1] = (value >> 16) & 0xff
  bytes[offset + 2] = (value >> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

function makeWav(sampleRate, channels, bits) {
  const blockAlign = channels * (bits / 8)
  const dataSize = blockAlign * 32
  const bytes = new Uint8Array(44 + dataSize)
  writeAscii(bytes, 0, 'RIFF')
  u32le(bytes, 4, 36 + dataSize)
  writeAscii(bytes, 8, 'WAVE')
  writeAscii(bytes, 12, 'fmt ')
  u32le(bytes, 16, 16)
  u16le(bytes, 20, 1)
  u16le(bytes, 22, channels)
  u32le(bytes, 24, sampleRate)
  u32le(bytes, 28, sampleRate * blockAlign)
  u16le(bytes, 32, blockAlign)
  u16le(bytes, 34, bits)
  writeAscii(bytes, 36, 'data')
  u32le(bytes, 40, dataSize)
  return bytes
}

function makeFlac(sampleRate, channels, bits) {
  const bytes = new Uint8Array(64)
  writeAscii(bytes, 0, 'fLaC')
  bytes[4] = 0x80 // last metadata block, type 0 (STREAMINFO)
  bytes[5] = 0
  bytes[6] = 0
  bytes[7] = 34
  const offset = 8
  u16le(bytes, offset, 4096) // min block size
  u16le(bytes, offset + 2, 4096) // max block size
  // min/max frame size left as zero
  // sample rate (20) | channels-1 (3) | bps-1 (5) | total samples (36)
  bytes[offset + 10] = (sampleRate >> 12) & 0xff
  bytes[offset + 11] = (sampleRate >> 4) & 0xff
  bytes[offset + 12] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | (((bits - 1) >> 4) & 0x01)
  bytes[offset + 13] = (((bits - 1) & 0x0f) << 4) | 0
  return bytes
}

function makeMp3(sampleRateIndex) {
  const bytes = new Uint8Array(256)
  // MPEG1 Layer III, 128 kbps, sample rate index, no CRC, stereo
  bytes[0] = 0xff
  bytes[1] = 0xfb
  bytes[2] = (0x09 << 4) | (sampleRateIndex << 2) | 0
  bytes[3] = 0x00
  return bytes
}

function makeOggVorbis(sampleRate, channels) {
  const bytes = new Uint8Array(128)
  writeAscii(bytes, 0, 'OggS')
  bytes[26] = 1 // one segment
  bytes[27] = 30 // segment length
  let offset = 28
  bytes[offset] = 0x01
  writeAscii(bytes, offset + 1, 'vorbis')
  u32le(bytes, offset + 7, 0)
  bytes[offset + 11] = channels
  u32le(bytes, offset + 12, sampleRate)
  return bytes
}

function makeOggOpus(channels) {
  const bytes = new Uint8Array(128)
  writeAscii(bytes, 0, 'OggS')
  bytes[26] = 1
  bytes[27] = 19
  let offset = 28
  writeAscii(bytes, offset, 'OpusHead')
  bytes[offset + 8] = 1
  bytes[offset + 9] = channels
  u16le(bytes, offset + 10, 312)
  u32le(bytes, offset + 12, 48000)
  return bytes
}

function makeMp4(sampleRate, channels) {
  const bytes = new Uint8Array(256)
  // ftyp
  u32be(bytes, 0, 24)
  writeAscii(bytes, 4, 'ftyp')
  writeAscii(bytes, 8, 'M4A ')
  // moov (size patched later) at 24
  const moovStart = 24
  writeAscii(bytes, moovStart + 4, 'moov')
  // mdhd at moov+8
  const mdhdStart = moovStart + 8
  u32be(bytes, mdhdStart, 32)
  writeAscii(bytes, mdhdStart + 4, 'mdhd')
  bytes[mdhdStart + 8] = 0 // version 0
  u32be(bytes, mdhdStart + 16, sampleRate) // timescale
  u32be(bytes, mdhdStart + 20, 0) // duration
  // stsd at mdhdStart+32
  const stsdStart = mdhdStart + 32
  u32be(bytes, stsdStart, 96)
  writeAscii(bytes, stsdStart + 4, 'stsd')
  u32be(bytes, stsdStart + 12, 1) // entry count
  const entry = stsdStart + 16
  u32be(bytes, entry, 80)
  writeAscii(bytes, entry + 4, 'mp4a')
  u16be(bytes, entry + 24, channels)
  u16be(bytes, entry + 26, 16)
  u32be(bytes, entry + 32, sampleRate * 65536)
  u32be(bytes, moovStart, 8 + 32 + 96)
  return bytes
}

function u16be(bytes, offset, value) {
  bytes[offset] = (value >> 8) & 0xff
  bytes[offset + 1] = value & 0xff
}

function makeAdts(sampleRateIndex, channels) {
  const bytes = new Uint8Array(64)
  bytes[0] = 0xff
  bytes[1] = 0xf1
  bytes[2] = ((1 & 0x03) << 6) | (sampleRateIndex << 2) | ((channels >> 2) & 0x01)
  bytes[3] = ((channels & 0x03) << 6)
  return bytes
}

check('wav 44.1k/2ch/16bit', probeAudioFormat(makeWav(44100, 2, 16)), {
  container: 'wav', sampleRate: 44100, channels: 2, bitsPerSample: 16, lossless: true,
})
check('wav 96k/2ch/24bit', probeAudioFormat(makeWav(96000, 2, 24)), {
  container: 'wav', sampleRate: 96000, channels: 2, bitsPerSample: 24, lossless: true,
})
check('flac 96k/2ch/24bit', probeAudioFormat(makeFlac(96000, 2, 24)), {
  container: 'flac', sampleRate: 96000, channels: 2, bitsPerSample: 24, lossless: true,
})
check('flac 44.1k/2ch/16bit', probeAudioFormat(makeFlac(44100, 2, 16)), {
  container: 'flac', sampleRate: 44100, channels: 2, bitsPerSample: 16, lossless: true,
})
check('mp3 44.1k stereo', probeAudioFormat(makeMp3(0)), {
  container: 'mp3', sampleRate: 44100, channels: 2, lossless: false,
})
check('mp3 48k stereo', probeAudioFormat(makeMp3(1)), {
  container: 'mp3', sampleRate: 48000, channels: 2, lossless: false,
})
check('ogg vorbis 48k/2ch', probeAudioFormat(makeOggVorbis(48000, 2)), {
  container: 'ogg', sampleRate: 48000, channels: 2, lossless: false,
})
check('ogg opus 48k/2ch', probeAudioFormat(makeOggOpus(2)), {
  container: 'opus', sampleRate: 48000, channels: 2, lossless: false,
})
check('m4a 44.1k/2ch', probeAudioFormat(makeMp4(44100, 2)), {
  container: 'mp4', sampleRate: 44100, channels: 2, lossless: false,
})
check('adts aac 48k/2ch', probeAudioFormat(makeAdts(3, 2)), {
  container: 'aac', sampleRate: 48000, channels: 2, lossless: false,
})
check('garbage falls back to unknown', probeAudioFormat(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])), {
  container: 'unknown', sampleRate: null, channels: null, bitsPerSample: null, lossless: false,
})

fs.rmSync(outDir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`[probe] ${failures} failure(s)`)
  process.exit(1)
}
console.log('[probe] OK')
