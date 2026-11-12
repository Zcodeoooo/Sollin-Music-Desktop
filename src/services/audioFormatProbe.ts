// Minimal audio container probe used by the WASAPI exclusive output path.
//
// Chromium's decodeAudioData() always resamples to the target AudioContext
// sample rate, so bit-perfect playback requires decoding at the file's native
// rate.  This module reads just enough of the container header to learn that
// rate (plus channel count and bit depth) without pulling a full metadata
// parser into the renderer bundle.
//
// Every field is best effort: when the container is unknown or malformed the
// probe reports nulls and the caller falls back to a non bit-perfect path.

export type AudioContainer =
  | 'wav'
  | 'flac'
  | 'mp3'
  | 'ogg'
  | 'opus'
  | 'mp4'
  | 'aac'
  | 'unknown'

export interface AudioFormatProbeResult {
  container: AudioContainer
  sampleRate: number | null
  channels: number | null
  bitsPerSample: number | null
  lossless: boolean
  codec: string | null
}

const EMPTY_PROBE: AudioFormatProbeResult = {
  container: 'unknown',
  sampleRate: null,
  channels: null,
  bitsPerSample: null,
  lossless: false,
  codec: null,
}

function readFourCC(bytes: Uint8Array, offset: number): string {
  if (offset < 0 || offset + 4 > bytes.length) return ''
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return ''
  let text = ''
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index])
  }
  return text
}

function readUint16BE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 2 > bytes.length) return null
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readUint16LE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 2 > bytes.length) return null
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readUint32BE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null
  return (
    (bytes[offset] * 0x1000000) +
    ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  )
}

function readUint32LE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null
  return (
    bytes[offset] +
    (bytes[offset + 1] << 8) +
    (bytes[offset + 2] << 16) +
    (bytes[offset + 3] * 0x1000000)
  )
}

function readUint64BE(bytes: Uint8Array, offset: number): number | null {
  const high = readUint32BE(bytes, offset)
  const low = readUint32BE(bytes, offset + 4)
  if (high == null || low == null) return null
  return high * 0x100000000 + low
}

function isPlausibleSampleRate(value: number | null): value is number {
  if (value == null) return false
  return value >= 8000 && value <= 768000
}

function isPlausibleChannels(value: number | null): value is number {
  if (value == null) return false
  return value >= 1 && value <= 16
}

function parseWav(bytes: Uint8Array): AudioFormatProbeResult | null {
  if (readFourCC(bytes, 0) !== 'RIFF' || readFourCC(bytes, 8) !== 'WAVE') return null

  let offset = 12
  const limit = Math.min(bytes.length, 4 * 1024 * 1024)
  while (offset + 8 <= limit) {
    const chunkId = readFourCC(bytes, offset)
    const chunkSize = readUint32LE(bytes, offset + 4)
    if (chunkSize == null || chunkSize < 0) break
    const dataOffset = offset + 8

    if (chunkId === 'fmt ') {
      const formatTag = readUint16LE(bytes, dataOffset)
      const channels = readUint16LE(bytes, dataOffset + 2)
      const sampleRate = readUint32LE(bytes, dataOffset + 4)
      const bitsPerSample = readUint16LE(bytes, dataOffset + 14)

      let effectiveTag = formatTag ?? 0
      let validBits = bitsPerSample
      if (effectiveTag === 0xfffe) {
        const extensibleValidBits = readUint16LE(bytes, dataOffset + 18)
        effectiveTag = readUint16LE(bytes, dataOffset + 24) ?? 0
        if (extensibleValidBits != null && extensibleValidBits > 0) {
          validBits = extensibleValidBits
        }
      }

      const isFloat = effectiveTag === 3
      return {
        container: 'wav',
        sampleRate: isPlausibleSampleRate(sampleRate) ? sampleRate : null,
        channels: isPlausibleChannels(channels) ? channels : null,
        bitsPerSample: validBits && validBits > 0 ? validBits : null,
        lossless: true,
        codec: isFloat ? 'pcm-f32' : 'pcm',
      }
    }

    // Chunks are word aligned.
    offset = dataOffset + chunkSize + (chunkSize % 2)
  }

  return null
}

function parseFlac(bytes: Uint8Array): AudioFormatProbeResult | null {
  if (readFourCC(bytes, 0) !== 'fLaC') return null
  if (bytes.length < 26) return null

  // First metadata block must be STREAMINFO (type 0).
  const header = bytes[4]
  const blockType = header & 0x7f
  if (blockType !== 0) return null

  const dataOffset = 8
  const sampleRate = ((bytes[dataOffset + 10] << 12) | (bytes[dataOffset + 11] << 4) | (bytes[dataOffset + 12] >> 4))
  const channels = ((bytes[dataOffset + 12] >> 1) & 0x07) + 1
  const bitsPerSample = (((bytes[dataOffset + 12] & 0x01) << 4) | (bytes[dataOffset + 13] >> 4)) + 1

  return {
    container: 'flac',
    sampleRate: isPlausibleSampleRate(sampleRate) ? sampleRate : null,
    channels: isPlausibleChannels(channels) ? channels : null,
    bitsPerSample: bitsPerSample > 0 && bitsPerSample <= 32 ? bitsPerSample : null,
    lossless: true,
    codec: 'flac',
  }
}

function skipId3v2(bytes: Uint8Array): number {
  if (bytes.length < 10) return 0
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0
  const size = (
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f)
  )
  const hasFooter = (bytes[5] & 0x10) !== 0
  return 10 + size + (hasFooter ? 10 : 0)
}

const MPEG_SAMPLE_RATES: Record<number, number[]> = {
  0: [11025, 12000, 8000], // MPEG 2.5
  2: [22050, 24000, 16000], // MPEG 2
  3: [44100, 48000, 32000], // MPEG 1
}

function parseMpegAudioFrame(bytes: Uint8Array, start: number) {
  const limit = Math.min(bytes.length - 3, start + 512 * 1024)
  for (let offset = start; offset < limit; offset += 1) {
    if (bytes[offset] !== 0xff) continue
    const second = bytes[offset + 1]
    if ((second & 0xe0) !== 0xe0) continue

    const versionBits = (second >> 3) & 0x03
    const layerBits = (second >> 1) & 0x03
    if (versionBits === 1 || layerBits === 0) continue

    const third = bytes[offset + 2]
    const bitrateIndex = (third >> 4) & 0x0f
    const sampleRateIndex = (third >> 2) & 0x03
    if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) continue

    const rates = MPEG_SAMPLE_RATES[versionBits]
    const sampleRate = rates?.[sampleRateIndex]
    if (!sampleRate) continue

    const fourth = bytes[offset + 3]
    const channelMode = (fourth >> 6) & 0x03
    const channels = channelMode === 3 ? 1 : 2
    return { sampleRate, channels, layer: layerBits }
  }
  return null
}

function parseMp3(bytes: Uint8Array): AudioFormatProbeResult | null {
  const start = skipId3v2(bytes)
  const frame = parseMpegAudioFrame(bytes, start)
  if (!frame) return null
  return {
    container: 'mp3',
    sampleRate: isPlausibleSampleRate(frame.sampleRate) ? frame.sampleRate : null,
    channels: isPlausibleChannels(frame.channels) ? frame.channels : null,
    bitsPerSample: null,
    lossless: false,
    codec: frame.layer === 1 ? 'mp3' : 'mpeg-audio',
  }
}

function parseOgg(bytes: Uint8Array): AudioFormatProbeResult | null {
  if (readFourCC(bytes, 0) !== 'OggS') return null
  if (bytes.length < 28) return null

  const segmentCount = bytes[26]
  const segmentTableEnd = 27 + segmentCount
  if (segmentTableEnd > bytes.length) return null

  const payloadStart = segmentTableEnd
  const opusHead = readFourCC(bytes, payloadStart)
  if (opusHead === 'Opus') {
    // OpusHead: magic(8) version(1) channels(1) preskip(2) input rate(4) ...
    const channels = bytes[payloadStart + 9]
    return {
      container: 'opus',
      // Opus always decodes at 48 kHz internally and is lossy, so the DAC will
      // always receive 48 kHz samples no matter what was encoded.
      sampleRate: 48000,
      channels: isPlausibleChannels(channels) ? channels : null,
      bitsPerSample: null,
      lossless: false,
      codec: 'opus',
    }
  }

  if (bytes[payloadStart] === 0x01 && readAscii(bytes, payloadStart + 1, 6) === 'vorbis') {
    const channels = bytes[payloadStart + 11]
    const sampleRate = readUint32LE(bytes, payloadStart + 12)
    return {
      container: 'ogg',
      sampleRate: isPlausibleSampleRate(sampleRate) ? sampleRate : null,
      channels: isPlausibleChannels(channels) ? channels : null,
      bitsPerSample: null,
      lossless: false,
      codec: 'vorbis',
    }
  }

  return null
}

function findBox(
  bytes: Uint8Array,
  start: number,
  end: number,
  type: string,
  depth: number,
): { offset: number; size: number } | null {
  if (depth > 8) return null
  let offset = start
  while (offset + 8 <= end) {
    const size = readUint32BE(bytes, offset)
    if (size == null) return null
    let boxSize = size
    const boxType = readFourCC(bytes, offset + 4)
    if (boxSize === 1) {
      const largeSize = readUint64BE(bytes, offset + 8)
      if (largeSize == null) return null
      boxSize = largeSize
      if (boxSize < 16) return null
    } else if (boxSize === 0) {
      boxSize = end - offset
    }
    if (boxSize < 8 || offset + boxSize > end) return null

    if (boxType === type) return { offset, size: boxSize }

    // Container boxes we need to descend into.
    if (boxType === 'moov' || boxType === 'trak' || boxType === 'mdia' ||
        boxType === 'minf' || boxType === 'stbl' || boxType === 'stsd' ||
        boxType === 'udta' || boxType === 'meta') {
      const headerSize = boxType === 'stsd' ? 16 : 8
      const found = findBox(bytes, offset + headerSize, offset + boxSize, type, depth + 1)
      if (found) return found
    }

    offset += boxSize
  }
  return null
}

function parseMp4(bytes: Uint8Array): AudioFormatProbeResult | null {
  const ftypOffset = readFourCC(bytes, 4) === 'ftyp' ? 4 : null
  if (ftypOffset == null) return null

  const moov = findBox(bytes, 0, bytes.length, 'moov', 0)
  if (!moov) return null

  let sampleRate: number | null = null
  let channels: number | null = null
  let bitsPerSample: number | null = null
  let codec: string | null = null
  let lossless = false

  const mdhd = findBox(bytes, moov.offset + 8, moov.offset + moov.size, 'mdhd', 1)
  if (mdhd) {
    const version = bytes[mdhd.offset + 8]
    const timescale = version === 1
      ? readUint32BE(bytes, mdhd.offset + 8 + 4 + 8 + 8)
      : readUint32BE(bytes, mdhd.offset + 8 + 4 + 4 + 4)
    if (isPlausibleSampleRate(timescale)) sampleRate = timescale
  }

  const stsd = findBox(bytes, moov.offset + 8, moov.offset + moov.size, 'stsd', 1)
  if (stsd) {
    // stsd: 8 byte header + 4 version/flags + 4 entry count, then sample entries
    const entryOffset = stsd.offset + 16
    const entryType = readFourCC(bytes, entryOffset + 4)
    codec = entryType || null
    lossless = entryType === 'alac'
    const channelCount = readUint16BE(bytes, entryOffset + 24)
    const sampleSize = readUint16BE(bytes, entryOffset + 26)
    const entrySampleRate = readUint32BE(bytes, entryOffset + 32)
    if (isPlausibleChannels(channelCount)) channels = channelCount
    if (sampleSize && sampleSize > 0 && sampleSize <= 32) bitsPerSample = sampleSize
    if (!sampleRate && entrySampleRate) {
      const fixed = entrySampleRate / 65536
      if (isPlausibleSampleRate(fixed)) sampleRate = Math.round(fixed)
    }
  }

  return {
    container: 'mp4',
    sampleRate,
    channels,
    bitsPerSample: lossless ? bitsPerSample : null,
    lossless,
    codec: codec ?? 'mp4a',
  }
}

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000,
  24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

function parseAdts(bytes: Uint8Array): AudioFormatProbeResult | null {
  const start = skipId3v2(bytes)
  if (start + 7 > bytes.length) return null
  if (bytes[start] !== 0xff || (bytes[start + 1] & 0xf0) !== 0xf0) return null

  const sampleRateIndex = (bytes[start + 2] >> 2) & 0x0f
  const sampleRate = AAC_SAMPLE_RATES[sampleRateIndex] ?? null
  const channels = ((bytes[start + 2] & 0x01) << 2) | ((bytes[start + 3] >> 6) & 0x03)

  return {
    container: 'aac',
    sampleRate: isPlausibleSampleRate(sampleRate) ? sampleRate : null,
    channels: channels > 0 && channels <= 8 ? channels : null,
    bitsPerSample: null,
    lossless: false,
    codec: 'aac',
  }
}

export function probeAudioFormat(bytes: Uint8Array): AudioFormatProbeResult {
  if (!bytes || bytes.length < 12) return { ...EMPTY_PROBE }

  try {
    return (
      parseWav(bytes) ||
      parseFlac(bytes) ||
      parseMp4(bytes) ||
      parseOgg(bytes) ||
      parseMp3(bytes) ||
      parseAdts(bytes) ||
      { ...EMPTY_PROBE }
    )
  } catch {
    return { ...EMPTY_PROBE }
  }
}
