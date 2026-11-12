// Main-process bridge for the optional WASAPI exclusive output addon.
//
// The addon (native/wasapi-exclusive) is loaded lazily.  Everything here is
// defensive: when the binary is missing (other platforms, unpackaged dev builds
// without `npm run wasapi:build`) the IPC handlers report `supported: false`
// and the renderer keeps using the normal Chromium audio pipeline.
import { ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

interface AddonFormat {
  sampleRate: number
  channels: number
  bits: number
  validBits: number
  isFloat: boolean
}

interface AddonOpenOptions {
  deviceId: string
  sampleRate: number
  channels: number
  formats: Array<{ bits: number; validBits: number; isFloat: boolean }>
  bufferMs?: number
  ringSeconds?: number
}

interface AddonOpenResult {
  format: AddonFormat
  deviceBufferFrames: number
  ringCapacityFrames: number
  blockAlign: number
  deviceName: string
}

interface AddonStatus {
  open: boolean
  playing?: boolean
  starved?: boolean
  positionFrames?: number
  bufferedFrames?: number
  ringCapacityFrames?: number
  deviceBufferFrames?: number
  format?: AddonFormat
  debug?: {
    events: number
    fills: number
    padding: number
    available: number
    lastHResult: number
    errors: number
  }
}

interface WasapiAddon {
  isAvailable(): boolean
  listDevices(): Array<{ id: string; name: string; isDefault: boolean }>
  probeFormats(deviceId: string, channels: number): {
    deviceId: string
    channels: number
    sampleRates: Array<{ sampleRate: number; formats: AddonFormat[] }>
  }
  open(options: AddonOpenOptions): AddonOpenResult
  write(pcm: Float32Array): { accepted: number; buffered: number; starved: boolean }
  status(): AddonStatus
  pause(): { ok: boolean }
  resume(): { ok: boolean }
  reset(): { ok: boolean }
  close(): { ok: boolean }
  getVolume(): { scalar: number; mute: boolean }
  setVolume(scalar: number, mute: boolean): { ok: boolean }
}

type IpcResult<T> = { ok: true; value: T } | { ok: false; code?: string; message: string }

const MAX_TRACK_BYTES = 320 * 1024 * 1024
// A stalled CDN response used to keep `arrayBuffer()` pending forever.  The
// exclusive engine serialises resource commits, so that also blocked the next
// track load and any device switch waiting behind it.  Keep the download well
// under the renderer's 25s "loading" watchdog and let the caller fall back to
// the normal Chromium pipeline.
const TRACK_DOWNLOAD_TIMEOUT_MS = 30_000

let addonLoaded = false
let addon: WasapiAddon | null = null
let addonError: string | null = null
let addonPath: string | null = null

function candidateAddonPaths(): string[] {
  const candidates: string[] = []
  const override = process.env.SOLLIN_WASAPI_ADDON
  if (override) candidates.push(override)

  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'native', 'wasapi_exclusive.node'))
  }

  // Development: dist-electron/../native/wasapi-exclusive/build/Release
  candidates.push(path.resolve(__dirname, '..', 'native', 'wasapi-exclusive', 'build', 'Release', 'wasapi_exclusive.node'))
  candidates.push(path.resolve(__dirname, '..', 'native', 'wasapi-exclusive', 'build', 'Debug', 'wasapi_exclusive.node'))
  return candidates
}

function loadAddon(): void {
  if (addonLoaded) return
  addonLoaded = true

  if (process.platform !== 'win32') {
    addonError = 'WASAPI 独占输出仅支持 Windows'
    return
  }

  const failures: string[] = []
  for (const candidate of candidateAddonPaths()) {
    if (!fs.existsSync(candidate)) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      addon = require(candidate) as WasapiAddon
      addonPath = candidate
      addonError = null
      return
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  addonError = failures.length > 0
    ? failures.join('; ')
    : '未找到 wasapi_exclusive.node，请先运行 npm run wasapi:build'
}

function requireAddon(): WasapiAddon {
  loadAddon()
  if (!addon) throw new Error(addonError || 'WASAPI 独占模块不可用')
  return addon
}

function toErrorPayload(error: unknown): { code?: string; message: string } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return {
      code: typeof code === 'string' ? code : undefined,
      message: error.message,
    }
  }
  return { message: String(error) }
}

function handle<T>(channel: string, handler: (...args: any[]) => T | Promise<T>) {
  ipcMain.handle(channel, async(_event, ...args: unknown[]): Promise<IpcResult<T>> => {
    try {
      return { ok: true, value: await handler(...args) }
    } catch (error) {
      return { ok: false, ...toErrorPayload(error) }
    }
  })
}

function decodeDataUrl(url: string): { bytes: Buffer; contentType: string | null } {
  const commaIndex = url.indexOf(',')
  if (commaIndex < 0) throw new Error('无效的 data URL')
  const meta = url.slice(5, commaIndex)
  const body = url.slice(commaIndex + 1)
  const contentType = meta.split(';')[0] || null
  const bytes = meta.includes(';base64')
    ? Buffer.from(body, 'base64')
    : Buffer.from(decodeURIComponent(body), 'utf8')
  return { bytes, contentType }
}

async function readTrackBytes(url: string): Promise<{ bytes: Buffer; contentType: string | null }> {
  const normalized = url.trim()
  if (!normalized) throw new Error('音频地址为空')

  if (/^data:/i.test(normalized)) {
    return decodeDataUrl(normalized)
  }

  if (/^file:/i.test(normalized)) {
    const filePath = fileURLToPath(normalized)
    const stat = await fs.promises.stat(filePath)
    if (stat.size > MAX_TRACK_BYTES) {
      throw new Error('音频文件过大，无法使用 WASAPI 独占输出')
    }
    return { bytes: await fs.promises.readFile(filePath), contentType: null }
  }

  if (/^https?:/i.test(normalized)) {
    const fetchFn = (globalThis as any).fetch as
      | ((input: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<any>)
      | undefined
    if (!fetchFn) throw new Error('当前环境不支持下载音频数据')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TRACK_DOWNLOAD_TIMEOUT_MS)

    try {
      const response = await fetchFn(normalized, {
        method: 'GET',
        headers: {
          // Many cloud music CDNs reject requests without a browser-ish UA.
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Sollin/1.0 Chrome/120.0 Safari/537.36',
        },
        signal: controller.signal,
      })
      if (!response?.ok) {
        throw new Error(`下载音频失败 (${response?.status || 'unknown'})`)
      }
      const contentLength = Number(response.headers?.get?.('content-length') || 0)
      if (contentLength > MAX_TRACK_BYTES) {
        throw new Error('音频文件过大，无法使用 WASAPI 独占输出')
      }
      const arrayBuffer = await response.arrayBuffer()
      if (arrayBuffer.byteLength > MAX_TRACK_BYTES) {
        throw new Error('音频文件过大，无法使用 WASAPI 独占输出')
      }
      return {
        bytes: Buffer.from(arrayBuffer),
        contentType: response.headers?.get?.('content-type') || null,
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('下载音频超时，已回退到常规输出')
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }

  throw new Error('WASAPI 独占输出不支持该音频地址')
}

export function setupWasapiOutputIpc(): void {
  handle('wasapi:devices', () => {
    loadAddon()
    if (!addon) {
      return { supported: false, devices: [], error: addonError ?? undefined, addonPath: addonPath ?? undefined }
    }
    try {
      return {
        supported: true,
        devices: addon.listDevices(),
        addonPath: addonPath ?? undefined,
      }
    } catch (error) {
      return {
        supported: false,
        devices: [],
        error: toErrorPayload(error).message,
        addonPath: addonPath ?? undefined,
      }
    }
  })

  handle('wasapi:probe', (deviceId: unknown, channels: unknown) => {
    const endpointId = String(deviceId || '')
    const channelCount = Number(channels) || 2
    if (!endpointId) throw new Error('缺少音频设备 ID')
    return requireAddon().probeFormats(endpointId, channelCount)
  })

  handle('wasapi:open', (options: unknown) => {
    const payload = (options ?? {}) as AddonOpenOptions
    if (!payload.deviceId) throw new Error('缺少音频设备 ID')
    if (!payload.sampleRate || !payload.channels) throw new Error('音频格式参数不完整')
    return requireAddon().open(payload)
  })

  handle('wasapi:write', (pcm: unknown) => {
    if (!(pcm instanceof Float32Array)) throw new Error('PCM 数据格式错误')
    return requireAddon().write(pcm)
  })

  handle('wasapi:status', () => requireAddon().status())

  handle('wasapi:control', (action: unknown) => {
    const name = String(action || '')
    const instance = requireAddon()
    if (name === 'pause') return instance.pause()
    if (name === 'resume') return instance.resume()
    if (name === 'reset') return instance.reset()
    throw new Error(`未知的 WASAPI 控制指令: ${name}`)
  })

  handle('wasapi:close', () => {
    loadAddon()
    if (!addon) return { ok: true }
    return addon.close()
  })

  handle('wasapi:get-volume', () => requireAddon().getVolume())

  handle('wasapi:set-volume', (scalar: unknown, mute: unknown) => {
    const value = Math.min(1, Math.max(0, Number(scalar)))
    if (!Number.isFinite(value)) throw new Error('音量参数无效')
    return requireAddon().setVolume(value, Boolean(mute))
  })

  handle('wasapi:load-track', (url: unknown) => {
    const source = String(url || '')
    if (!source) throw new Error('音频地址为空')
    return readTrackBytes(source)
  })

  // Exclusive playback feeds the device from a renderer-side timer.  Chromium
  // throttles timers of hidden/occluded pages (which is exactly what happens
  // when the window is minimised to the tray), so the pump starves and the
  // device falls back to silence until the window is shown again.  Exclusive
  // playback therefore disables background throttling for the owning
  // WebContents and restores it as soon as the stream stops.
  ipcMain.handle('wasapi:background-throttling', (event, disabled: unknown) => {
    const contents = event.sender
    try {
      if (!contents.isDestroyed()) {
        contents.setBackgroundThrottling(!Boolean(disabled))
      }
      return { ok: true, value: { throttlingDisabled: Boolean(disabled) } }
    } catch (error) {
      return { ok: false, ...toErrorPayload(error) }
    }
  })
}
