// Renderer side of the WASAPI exclusive (bit-perfect) output path.
//
// The engine replaces the <audio> element as the playback backend:
//   1. the track bytes are streamed through the main process (no CORS / file://
//      restrictions) and decoded with an OfflineAudioContext created at the
//      file's *native* sample rate, so Chromium performs no resampling;
//   2. the negotiated exclusive format is opened on the selected endpoint;
//   3. plane data is interleaved and pushed into the native ring buffer while
//      the device clock drives the UI position.
//
// When anything fails (unsupported codec, busy device, driver rejecting
// exclusive mode) the caller falls back to the regular Chromium path.
import type { PlayerBackend, PlayerCoreEvent } from '@/services/playerCore'
import { probeAudioFormat, type AudioFormatProbeResult } from '@/services/audioFormatProbe'
import {
  detectPcmNormalization,
  normalizationNeedsGain,
  type PcmNormalization,
} from '@/services/pcmNormalization'
import {
  describeWasapiFormat,
  type WasapiFormatDescriptor,
  type WasapiNegotiatedFormat,
  type WasapiOpenResult,
  type WasapiPlaybackInfo,
  type WasapiProbeResult,
  type WasapiStatus,
} from '@/types/wasapi'

const MAX_CHUNK_FRAMES = 8192
const PUMP_INTERVAL_MS = 40
const POLL_INTERVAL_MS = 120
const PRE_ROLL_SECONDS = 0.35
const END_EPSILON_SECONDS = 0.05
const STALL_LIMIT_TICKS = 45
// decodeAudioData cannot be cancelled.  Race it with a deadline so a
// pathological file can never keep the resource-commit queue — and whatever is
// waiting on it (track changes, device switches) — blocked indefinitely.
const DECODE_TIMEOUT_MS = 60_000
// Whole-track decoding keeps the PCM in memory; very long recordings (multi
// hour audiobooks) would exceed a reasonable renderer heap.  Such tracks fall
// back to the streaming Chromium path instead.
const MAX_DECODED_BYTES = 512 * 1024 * 1024

type WasapiIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; code?: string; message: string }

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type PlayerCoreEventPayload = DistributiveOmit<PlayerCoreEvent, 'currentSrc'>

interface WasapiExclusiveEngineOptions {
  endpointId: string
  emit: (event: PlayerCoreEvent) => void
  onInfo?: (info: WasapiPlaybackInfo) => void
}

function getApi() {
  return window.electronAPI
}

async function unwrap<T>(promise: Promise<WasapiIpcResult<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) {
    const error = new Error(result.message || 'WASAPI 独占输出调用失败') as Error & { code?: string }
    if (result.code) error.code = result.code
    throw error
  }
  return result.value
}

function errorCodeOf(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

const FORMAT_FAILURE_CODES = new Set([
  'UNSUPPORTED_FORMAT',
  'DEVICE_IN_USE',
  'EXCLUSIVE_MODE_NOT_ALLOWED',
  'ACCESS_DENIED',
  'ENDPOINT_CREATE_FAILED',
  'DEVICE_INVALIDATED',
  'AUDIO_SERVICE_NOT_RUNNING',
  'DEVICE_NOT_FOUND',
])

function messageForWasapiError(error: unknown): string {
  const code = errorCodeOf(error)
  const raw = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'DEVICE_IN_USE':
      return '该音频设备正被其他程序以独占模式占用，请关闭占用的程序后重试'
    case 'EXCLUSIVE_MODE_NOT_ALLOWED':
      return '系统已禁用该设备的独占模式（声音设置 → 设备属性 → 高级）'
    case 'UNSUPPORTED_FORMAT':
      return '该设备不支持当前音频格式的独占输出'
    case 'ACCESS_DENIED':
      return '没有访问该音频设备的权限'
    case 'DEVICE_INVALIDATED':
    case 'DEVICE_NOT_FOUND':
      return '音频设备已断开或不可用'
    case 'AUDIO_SERVICE_NOT_RUNNING':
      return 'Windows 音频服务未运行'
    case 'VOLUME_UNSUPPORTED':
      return '该设备不支持硬件音量控制，bit-perfect 模式下音量由系统/设备旋钮控制'
    default:
      return raw
  }
}

async function loadTrackBytes(source: string): Promise<ArrayBuffer> {
  const api = getApi()

  // blob:/data: URLs are only readable from the renderer.
  if (/^(blob:|data:)/i.test(source)) {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`读取音频数据失败 (${response.status})`)
    return response.arrayBuffer()
  }

  if (api?.wasapiLoadTrack) {
    const payload = await unwrap(api.wasapiLoadTrack(source))
    const bytes = payload.bytes
    // Electron hands Buffers over as Uint8Array views with a non-zero offset.
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  const response = await fetch(source)
  if (!response.ok) throw new Error(`读取音频数据失败 (${response.status})`)
  return response.arrayBuffer()
}

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timer != null) clearTimeout(timer)
  })
}

async function decodeAudioAtRate(bytes: ArrayBuffer, sampleRate: number): Promise<AudioBuffer> {
  const OfflineContext = window.OfflineAudioContext
  if (!OfflineContext) throw new Error('当前环境不支持离线音频解码')
  const context = new OfflineContext(2, 1, sampleRate)
  // decodeAudioData resamples to the context rate; choosing the file's native
  // rate is what keeps the chain bit-perfect.
  return await withDeadline(
    context.decodeAudioData(bytes.slice(0)),
    DECODE_TIMEOUT_MS,
    '独占模式解码超时，已回退到常规输出',
  )
}

function buildFormatPreferences(bitsPerSample: number | null): WasapiFormatDescriptor[] {
  const known = bitsPerSample != null && bitsPerSample > 0 ? bitsPerSample : null

  if (known === 16) {
    return [
      { bits: 16, validBits: 16, isFloat: false },
      { bits: 32, validBits: 24, isFloat: false },
      { bits: 24, validBits: 24, isFloat: false },
      { bits: 32, validBits: 32, isFloat: true },
    ]
  }

  if (known != null && known >= 17) {
    // 24 bit (and 32 bit float) sources: never accept a 16 bit container first.
    return [
      { bits: 24, validBits: 24, isFloat: false },
      { bits: 32, validBits: 24, isFloat: false },
      { bits: 32, validBits: 32, isFloat: true },
      { bits: 32, validBits: 32, isFloat: false },
    ]
  }

  // Lossy / unknown: keep the decoder's float precision when possible.
  return [
    { bits: 32, validBits: 32, isFloat: true },
    { bits: 32, validBits: 24, isFloat: false },
    { bits: 24, validBits: 24, isFloat: false },
    { bits: 16, validBits: 16, isFloat: false },
  ]
}

function isBitPerfectChain(
  probe: AudioFormatProbeResult,
  negotiated: WasapiNegotiatedFormat,
  resampled: boolean,
  normalization: PcmNormalization | null,
): boolean {
  if (resampled) return false
  if (probe.sampleRate != null && probe.sampleRate !== negotiated.sampleRate) return false

  const requestedBits = probe.bitsPerSample ?? 24
  const deliveredBits = negotiated.isFloat ? 32 : negotiated.validBits
  if (deliveredBits < requestedBits) return false

  // Float PCM is decoded without any normalization step, so the decoder output
  // can go straight to the endpoint.  Integer PCM only qualifies when the
  // decoder's normalization was identified (and therefore compensated).
  if (probe.codec === 'pcm-f32') return true
  if (probe.lossless) return normalization != null
  return true
}

export class WasapiExclusiveEngine implements PlayerBackend {
  readonly kind = 'wasapi' as const

  private readonly endpointId: string
  private readonly emit: (event: PlayerCoreEvent) => void
  private readonly onInfo?: (info: WasapiPlaybackInfo) => void

  private source: string | null = null
  private channelData: Float32Array[] = []
  private channelCount = 2
  private totalFrames = 0
  private rate = 48000
  private duration = 0
  private position = 0
  private writeCursor = 0
  private seekBaseFrame = 0
  private ringCapacityFrames = 0
  private deviceBufferFrames = 0
  private negotiated: WasapiNegotiatedFormat | null = null
  private deviceName: string | null = null
  private bitPerfect = false
  private resampled = false
  private sourceProbe: AudioFormatProbeResult | null = null
  private normalization: PcmNormalization | null = null
  private lastError: string | null = null

  private playing = false
  private loadingGeneration = 0
  private seekToken = 0
  private lastSeek: Promise<void> = Promise.resolve()
  private streamEpoch = 0
  private commitChain: Promise<void> = Promise.resolve()
  private disposed = false
  private endedEmitted = false
  private pumpTimer: number | null = null
  private pollTimer: number | null = null
  private pumping = false
  private polling = false
  private throttlingDisabled = false
  private interleaveBuffer: Float32Array = new Float32Array(0)
  private pendingVolume = 1
  private pendingMuted = false
  private stallTicks = 0
  private lastPositionFrames = -1

  constructor(options: WasapiExclusiveEngineOptions) {
    this.endpointId = options.endpointId
    this.emit = options.emit
    this.onInfo = options.onInfo
  }

  getEndpointId() {
    return this.endpointId
  }

  getPlaybackInfo(): WasapiPlaybackInfo {
    return {
      active: Boolean(this.negotiated),
      deviceId: this.endpointId,
      deviceName: this.deviceName,
      format: this.negotiated,
      bitPerfect: this.bitPerfect,
      sourceSampleRate: this.sourceProbe?.sampleRate ?? this.rate,
      sourceBits: this.sourceProbe?.bitsPerSample ?? null,
      resampled: this.resampled,
      error: this.lastError,
    }
  }

  isEmpty() {
    return !this.source
  }

  getCurrentTime() {
    return this.position
  }

  getDuration() {
    return this.duration
  }

  async setResource(
    source: string,
    options?: { autoplay?: boolean; startTime?: number },
  ): Promise<string> {
    if (this.disposed) throw new Error('WASAPI 独占引擎已释放')

    const autoplay = options?.autoplay !== false
    const startTime = Math.max(0, Number(options?.startTime) || 0)
    const generation = ++this.loadingGeneration

    // Non native work can start immediately; the native stream is only touched
    // inside the commit lock so a slow previous load cannot open a stream after
    // a newer one.
    this.source = source
    this.lastError = null
    this.endedEmitted = false
    this.negotiated = null
    this.bitPerfect = false
    this.resampled = false
    this.publishInfo()

    this.emitEvent({ type: 'loadstart' })

    try {
      const bytes = await loadTrackBytes(source)
      if (generation !== this.loadingGeneration || this.disposed) return source

      const probe = probeAudioFormat(new Uint8Array(bytes))
      this.sourceProbe = probe

      const nativeRate = probe.sampleRate ?? 48000
      let decoded = await decodeAudioAtRate(bytes, nativeRate)
      if (generation !== this.loadingGeneration || this.disposed) return source

      const decodedBytes = decoded.length * decoded.numberOfChannels * 4
      if (decodedBytes > MAX_DECODED_BYTES) {
        throw new Error('音频过长，独占模式解码所需内存超出上限，已回退到常规输出')
      }

      const channels = Math.max(1, decoded.numberOfChannels)
      const preferences = buildFormatPreferences(probe.bitsPerSample)

      const committed = await this.withCommitLock(async() => {
        if (generation !== this.loadingGeneration || this.disposed) return false

        await this.teardownStream(false)
        if (generation !== this.loadingGeneration || this.disposed) return false

        let opened: WasapiOpenResult
        try {
          opened = await this.openNative(decoded.sampleRate, channels, preferences)
        } catch (error) {
          if (!FORMAT_FAILURE_CODES.has(errorCodeOf(error) ?? '')) throw error

          // The endpoint does not accept the file's native rate in exclusive
          // mode.  Resample to a rate it does support and mark the chain as not
          // bit-perfect instead of failing playback.
          const fallbackRate = await this.pickFallbackRate(channels, decoded.sampleRate)
          if (!fallbackRate) throw error

          const resampled = await decodeAudioAtRate(bytes, fallbackRate)
          if (generation !== this.loadingGeneration || this.disposed) {
            await this.closeNative()
            return false
          }
          decoded = resampled
          this.resampled = true
          opened = await this.openNative(decoded.sampleRate, channels, preferences)
        }

        if (generation !== this.loadingGeneration || this.disposed) {
          await this.closeNative()
          return false
        }

        this.negotiated = opened.format
        this.deviceName = opened.deviceName || null
        this.rate = opened.format.sampleRate
        this.channelCount = opened.format.channels
        this.ringCapacityFrames = opened.ringCapacityFrames
        this.deviceBufferFrames = opened.deviceBufferFrames
        this.channelData = []
        for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
          this.channelData.push(decoded.getChannelData(channel))
        }
        this.totalFrames = decoded.length
        this.duration = decoded.duration
        this.position = Math.min(this.duration, startTime)
        this.seekBaseFrame = Math.min(this.totalFrames, Math.round(startTime * this.rate))
        this.writeCursor = this.seekBaseFrame

        // Identify (and later invert) the decoder's integer normalization so the
        // original integer samples reach the endpoint unchanged.  Resampled audio
        // can never be bit-perfect, so the detection is skipped there.
        this.normalization = null
        if (!this.resampled && probe.lossless && probe.bitsPerSample != null && probe.bitsPerSample >= 8) {
          this.normalization = detectPcmNormalization(this.channelData, probe.bitsPerSample)
        }
        this.bitPerfect = isBitPerfectChain(probe, opened.format, this.resampled, this.normalization)

        await this.applyVolume()
        await this.writeAvailableData(this.preRollFrames())
        if (generation !== this.loadingGeneration || this.disposed) {
          await this.closeNative()
          this.negotiated = null
          return false
        }

        this.streamEpoch += 1
        this.publishInfo()

        if (autoplay) {
          await this.start()
        }
        return true
      })

      if (!committed) return source

      this.emitEvent({ type: 'durationchange', duration: this.duration })
      this.emitEvent({ type: 'loadeddata' })
      this.emitEvent({ type: 'canplay' })
      return source
    } catch (error) {
      if (generation !== this.loadingGeneration || this.disposed) return source
      this.lastError = messageForWasapiError(error)
      this.publishInfo()
      await this.setWindowThrottling(false)
      await this.withCommitLock(async() => {
        if (generation !== this.loadingGeneration || this.disposed) return
        await this.teardownStream(true)
      })
      throw new Error(this.lastError)
    }
  }

  private async withCommitLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.commitChain
    let release: () => void = () => {}
    this.commitChain = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await task()
    } finally {
      release()
    }
  }

  async play(): Promise<void> {
    if (!this.source || this.totalFrames === 0) {
      throw new Error(this.lastError || '当前没有可播放的独占音频')
    }
    if (this.playing) return

    if (this.endedEmitted) {
      // Replay from the beginning: wait for the async reset, then start.
      this.endedEmitted = false
      this.seek(0)
      await this.lastSeek
      if (this.disposed) return
      await this.start()
      return
    }

    await this.start()
  }

  pause(): void {
    if (!this.source) return
    const wasPlaying = this.playing
    this.playing = false
    this.stopTimers()
    void this.setWindowThrottling(false)
    if (wasPlaying) {
      void unwrap(getApi()!.wasapiControl('pause')).catch(() => {})
    }
    this.emitEvent({ type: 'pause' })
  }

  stop(): void {
    void this.teardownStream(true)
    void this.setWindowThrottling(false)
    this.source = null
    this.channelData = []
    this.totalFrames = 0
    this.duration = 0
    this.position = 0
    this.negotiated = null
    this.bitPerfect = false
    this.publishInfo()
  }

  seek(time: number): void {
    if (!this.source || this.totalFrames === 0) return
    const target = Math.max(0, Math.min(this.duration, Number(time) || 0))
    this.position = target
    this.endedEmitted = false
    this.emitEvent({ type: 'timeupdate', currentTime: target })
    this.lastSeek = this.applySeek(target)
  }

  setVolume(volume: number, muted = false): void {
    this.pendingVolume = Math.max(0, Math.min(1, Number(volume) || 0))
    this.pendingMuted = muted
    void this.applyVolume()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.loadingGeneration += 1
    await this.teardownStream(false)
    await this.setWindowThrottling(false)
    this.publishInfo()
  }

  // ---- internals ---------------------------------------------------------

  private emitEvent(event: PlayerCoreEventPayload) {
    this.emit({ ...event, currentSrc: this.source ?? '' } as PlayerCoreEvent)
  }

  private publishInfo() {
    this.onInfo?.(this.getPlaybackInfo())
  }

  private preRollFrames() {
    const minimum = Math.max(this.deviceBufferFrames * 2, Math.round(this.rate * PRE_ROLL_SECONDS))
    return Math.min(minimum, Math.max(0, this.totalFrames - this.writeCursor))
  }

  private async start() {
    const epoch = this.streamEpoch
    // The device is fed from this renderer, so a hidden window must keep its
    // timers running at full rate (Chromium throttles hidden pages, which used
    // to starve the ring buffer a second after minimising).
    await this.setWindowThrottling(true)
    await unwrap(getApi()!.wasapiControl('resume'))
    if (epoch !== this.streamEpoch || this.disposed) return
    this.playing = true
    this.lastPositionFrames = -1
    this.stallTicks = 0
    this.startTimers()
    this.emitEvent({ type: 'playing' })
  }

  private async setWindowThrottling(disabled: boolean) {
    if (this.throttlingDisabled === disabled) return
    const api = getApi()
    if (!api?.wasapiSetBackgroundThrottling) return
    this.throttlingDisabled = disabled
    try {
      await unwrap(api.wasapiSetBackgroundThrottling(disabled))
    } catch {
      // Not critical for playback correctness on platforms that ignore it.
    }
  }

  private async applySeek(target: number) {
    const token = ++this.seekToken
    const epoch = this.streamEpoch
    const wasPlaying = this.playing
    this.playing = false
    this.stopTimers()

    try {
      await unwrap(getApi()!.wasapiControl('reset'))
      if (token !== this.seekToken || epoch !== this.streamEpoch || this.disposed) return

      this.seekBaseFrame = Math.min(this.totalFrames, Math.round(target * this.rate))
      this.writeCursor = this.seekBaseFrame
      this.position = this.seekBaseFrame / this.rate
      this.lastPositionFrames = -1
      this.stallTicks = 0

      await this.writeAvailableData(this.preRollFrames())
      if (token !== this.seekToken || this.disposed) return

      this.emitEvent({ type: 'timeupdate', currentTime: this.position })
      if (wasPlaying) {
        await unwrap(getApi()!.wasapiControl('resume'))
        if (token !== this.seekToken || epoch !== this.streamEpoch || this.disposed) return
        this.playing = true
        this.startTimers()
      }
    } catch (error) {
      if (token !== this.seekToken || this.disposed) return
      this.fail(error)
    }
  }

  private startTimers() {
    this.stopTimers()
    this.pumpTimer = window.setInterval(() => {
      void this.pumpOnce()
    }, PUMP_INTERVAL_MS)
    this.pollTimer = window.setInterval(() => {
      void this.pollOnce()
    }, POLL_INTERVAL_MS)
  }

  private stopTimers() {
    if (this.pumpTimer != null) {
      window.clearInterval(this.pumpTimer)
      this.pumpTimer = null
    }
    if (this.pollTimer != null) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async pumpOnce() {
    if (!this.playing || this.pumping || this.disposed) return
    this.pumping = true
    try {
      await this.writeAvailableData()
    } catch (error) {
      this.fail(error)
    } finally {
      this.pumping = false
    }
  }

  private async pollOnce() {
    if (!this.playing || this.polling || this.disposed) return
    this.polling = true
    const epoch = this.streamEpoch
    try {
      const status = await this.statusNative()
      if (epoch !== this.streamEpoch) return
      if (!status.open) {
        this.fail(new Error('WASAPI 独占音频流已关闭'))
        return
      }

      const frames = status.positionFrames ?? 0
      const deviceSeconds = this.rate > 0 ? frames / this.rate : 0
      const nextPosition = Math.max(0, this.seekBaseFrame / this.rate + deviceSeconds)
      this.position = Math.min(this.duration, nextPosition)
      this.emitEvent({ type: 'timeupdate', currentTime: this.position })

      // A parked stream (producer starved) freezes the device clock on purpose;
      // that is not a device failure.  The pump restarts it as soon as it has
      // data again.
      if (status.starved) {
        this.lastPositionFrames = frames
        this.stallTicks = 0
      } else if (frames === this.lastPositionFrames) {
        this.stallTicks += 1
        if (this.stallTicks >= STALL_LIMIT_TICKS) {
          this.fail(new Error('音频设备停止推进，独占输出可能已被系统中断'))
          return
        }
      } else {
        this.lastPositionFrames = frames
        this.stallTicks = 0
      }

      if (this.writeCursor >= this.totalFrames && this.position >= this.duration - END_EPSILON_SECONDS) {
        await this.finish()
      }
    } catch (error) {
      this.fail(error)
    } finally {
      this.polling = false
    }
  }

  private async writeAvailableData(maxFrames = Number.POSITIVE_INFINITY): Promise<number> {
    if (this.totalFrames === 0 || this.disposed) return 0
    if (!getApi()?.wasapiWrite) throw new Error('WASAPI 独占写入接口不可用')

    const epoch = this.streamEpoch
    const status = await this.statusNative()
    if (epoch !== this.streamEpoch) return 0
    if (!status.open) return 0

    const capacity = this.ringCapacityFrames || status.ringCapacityFrames || 0
    let free = Math.max(0, capacity - (status.bufferedFrames ?? 0))
    let written = 0
    let starved = Boolean(status.starved)

    while (free > 0 && this.writeCursor < this.totalFrames && written < maxFrames) {
      const frames = Math.min(
        free,
        this.totalFrames - this.writeCursor,
        MAX_CHUNK_FRAMES,
        maxFrames - written,
      )
      if (frames <= 0) break

      const pcm = this.interleave(this.writeCursor, frames)
      const result = await unwrap(getApi()!.wasapiWrite(pcm))
      if (epoch !== this.streamEpoch) return written
      starved = Boolean(result.starved)
      const accepted = Math.max(0, Math.min(frames, result.accepted))
      if (accepted === 0) break
      this.writeCursor += accepted
      written += accepted
      free -= accepted
    }

    // The native renderer parks the stream when it runs dry so the device clock
    // stays on the audio content.  As soon as this tick queued new data, start
    // it again.  At the very end of a track nothing is queued and the park is
    // final (the poll loop emits "ended").
    if (starved && written > 0 && this.playing && epoch === this.streamEpoch) {
      try {
        await unwrap(getApi()!.wasapiControl('resume'))
        if (!this.playing || epoch !== this.streamEpoch) {
          // A pause landed while the resume was in flight.
          await unwrap(getApi()!.wasapiControl('pause'))
        }
      } catch {
        // The poll loop reports a hard failure if the stream stays dead.
      }
    }

    return written
  }

  private interleave(startFrame: number, frameCount: number): Float32Array {
    const channels = this.channelCount
    const needed = frameCount * channels
    if (this.interleaveBuffer.length < needed) {
      this.interleaveBuffer = new Float32Array(needed)
    }
    const target = this.interleaveBuffer.subarray(0, needed)
    const planes = this.channelData
    const normalization = this.normalization
    const needsGain = normalizationNeedsGain(normalization)
    const gainPositive = normalization ? normalization.positiveGain : 1
    const gainNegative = normalization ? normalization.negativeGain : 1

    const convert = (value: number): number => {
      if (!needsGain) return value
      return value >= 0 ? value * gainPositive : value * gainNegative
    }

    if (planes.length === 1) {
      const mono = planes[0]
      for (let frame = 0; frame < frameCount; frame += 1) {
        const value = convert(mono[startFrame + frame] || 0)
        for (let channel = 0; channel < channels; channel += 1) {
          target[frame * channels + channel] = value
        }
      }
      return target
    }

    for (let channel = 0; channel < channels; channel += 1) {
      const plane = planes[channel] ?? planes[0]
      for (let frame = 0; frame < frameCount; frame += 1) {
        target[frame * channels + channel] = convert(plane[startFrame + frame] || 0)
      }
    }
    return target
  }

  private async finish() {
    if (this.endedEmitted) return
    this.endedEmitted = true
    this.playing = false
    this.stopTimers()
    this.position = this.duration
    const epoch = this.streamEpoch
    await this.setWindowThrottling(false)
    try {
      await unwrap(getApi()!.wasapiControl('pause'))
    } catch {
      // The stream is already finished; a failing pause must not break the
      // "next track" transition.
    }
    if (epoch !== this.streamEpoch) return
    this.emitEvent({ type: 'ended' })
  }

  private fail(error: unknown) {
    this.lastError = messageForWasapiError(error)
    this.playing = false
    this.stopTimers()
    this.publishInfo()
    this.emitEvent({
      type: 'error',
      error: null,
      networkState: 0,
      readyState: 0,
    })
  }

  private async teardownStream(reportInfo: boolean) {
    this.streamEpoch += 1
    this.playing = false
    this.stopTimers()
    this.negotiated = null
    this.ringCapacityFrames = 0
    this.deviceBufferFrames = 0
    await this.closeNative()
    if (reportInfo) this.publishInfo()
  }

  private async closeNative() {
    try {
      if (getApi()?.wasapiClose) {
        await unwrap(getApi()!.wasapiClose())
      }
    } catch {
      // Closing an already closed stream is expected during rapid track changes.
    }
  }

  private async statusNative(): Promise<WasapiStatus> {
    const api = getApi()
    if (!api?.wasapiStatus) throw new Error('WASAPI 独占状态接口不可用')
    return await unwrap(api.wasapiStatus())
  }

  private async openNative(
    sampleRate: number,
    channels: number,
    formats: WasapiFormatDescriptor[],
  ): Promise<WasapiOpenResult> {
    const api = getApi()
    if (!api?.wasapiOpen) throw new Error('WASAPI 独占输出不可用（未加载原生模块）')
    return await unwrap(api.wasapiOpen({
      deviceId: this.endpointId,
      sampleRate,
      channels,
      formats,
      bufferMs: 100,
      // 2 seconds absorb renderer scheduling hiccups (GC, IPC bursts) that the
      // 1 second buffer used to turn into audible gaps.
      ringSeconds: 2,
    }))
  }

  private async pickFallbackRate(channels: number, currentRate: number): Promise<number | null> {
    const api = getApi()
    if (!api?.wasapiProbeFormats) return null

    let probe: WasapiProbeResult
    try {
      probe = await unwrap(api.wasapiProbeFormats(this.endpointId, channels))
    } catch {
      return null
    }

    const supportsRate = (rate: number) => probe.sampleRates.some((entry) =>
      entry.sampleRate === rate && entry.formats.length > 0)

    const ordered = [48000, 44100, 96000, 88200, 192000, 176400, 352800, 384000]
    for (const rate of ordered) {
      if (rate !== currentRate && supportsRate(rate)) return rate
    }

    const any = probe.sampleRates.find((entry) => entry.formats.length > 0 && entry.sampleRate !== currentRate)
    return any ? any.sampleRate : null
  }

  private async applyVolume() {
    const api = getApi()
    if (!api?.wasapiSetVolume || !this.negotiated) return
    try {
      await unwrap(api.wasapiSetVolume(this.pendingVolume, this.pendingMuted))
    } catch {
      // Hardware volume is optional; the samples themselves stay untouched.
    }
  }
}

export function describePlaybackFormat(info: WasapiPlaybackInfo | null): string {
  if (!info?.format) return ''
  return describeWasapiFormat(info.format)
}

export function isWasapiOutputAvailable(): boolean {
  return Boolean(getApi()?.wasapiListDevices)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export interface WasapiTestToneResult {
  format: WasapiNegotiatedFormat
  deviceName: string
}

/**
 * Plays a short sine through the endpoint in exclusive mode.  Used by the
 * settings panel to prove that the device really accepts bit-perfect output.
 * The caller must make sure no other exclusive stream is active on that device.
 */
export async function playWasapiOutputTestTone(
  endpointId: string,
  options?: { seconds?: number; frequency?: number },
): Promise<WasapiTestToneResult> {
  const api = getApi()
  if (!api?.wasapiOpen || !api.wasapiWrite || !api.wasapiControl) {
    throw new Error('WASAPI 独占输出不可用（未加载原生模块）')
  }

  const requestedRate = 48000
  const channels = 2
  const seconds = Math.max(0.3, Math.min(3, options?.seconds ?? 1.2))
  const frequency = options?.frequency ?? 440

  const opened = await unwrap(api.wasapiOpen({
    deviceId: endpointId,
    sampleRate: requestedRate,
    channels,
    formats: [
      { bits: 24, validBits: 24, isFloat: false },
      { bits: 32, validBits: 24, isFloat: false },
      { bits: 16, validBits: 16, isFloat: false },
    ],
    bufferMs: 100,
    ringSeconds: 1,
  }))

  const rate = opened.format.sampleRate
  const outChannels = opened.format.channels
  const totalFrames = Math.round(rate * seconds)
  const pcm = new Float32Array(totalFrames * outChannels)
  const fadeFrames = Math.max(1, Math.round(rate * 0.02))
  for (let frame = 0; frame < totalFrames; frame += 1) {
    const envelope = Math.min(1, frame / fadeFrames, (totalFrames - frame) / fadeFrames)
    const value = Math.sin((2 * Math.PI * frequency * frame) / rate) * 0.15 * envelope
    for (let channel = 0; channel < outChannels; channel += 1) {
      pcm[frame * outChannels + channel] = value
    }
  }

  try {
    let writtenFrames = 0
    const writeDeadline = performance.now() + 8000
    while (writtenFrames < totalFrames && performance.now() < writeDeadline) {
      const chunk = Math.min(totalFrames - writtenFrames, 4096)
      const slice = pcm.subarray(
        writtenFrames * outChannels,
        (writtenFrames + chunk) * outChannels,
      )
      const result = await unwrap(api.wasapiWrite(slice))
      writtenFrames += result.accepted
      if (result.accepted === 0) {
        await sleep(20)
        const status = await unwrap(api.wasapiStatus())
        if ((status.bufferedFrames ?? 0) >= (status.ringCapacityFrames ?? 0)) break
      }
    }

    await unwrap(api.wasapiControl('resume'))

    const playDeadline = performance.now() + seconds * 1000 + 4000
    while (performance.now() < playDeadline) {
      await sleep(60)
      const status = await unwrap(api.wasapiStatus())
      if (!status.open) break
      if ((status.positionFrames ?? 0) >= writtenFrames) break
    }

    return { format: opened.format, deviceName: opened.deviceName }
  } finally {
    try {
      await unwrap(api.wasapiClose())
    } catch {
      // The stream may already be gone; nothing else to clean up.
    }
  }
}
