// Shared TypeScript contracts between the Electron main process and the
// renderer for the WASAPI exclusive output path.

export const WASAPI_DEVICE_PREFIX = 'wasapi:'

export interface WasapiDeviceInfo {
  id: string
  name: string
  isDefault: boolean
}

export interface WasapiFormatDescriptor {
  bits: number
  validBits: number
  isFloat: boolean
}

export interface WasapiSampleRateSupport {
  sampleRate: number
  formats: WasapiFormatDescriptor[]
}

export interface WasapiProbeResult {
  deviceId: string
  channels: number
  sampleRates: WasapiSampleRateSupport[]
}

export interface WasapiNegotiatedFormat {
  sampleRate: number
  channels: number
  bits: number
  validBits: number
  isFloat: boolean
}

export interface WasapiOpenResult {
  format: WasapiNegotiatedFormat
  deviceBufferFrames: number
  ringCapacityFrames: number
  blockAlign: number
  deviceName: string
}

export interface WasapiDebugInfo {
  events: number
  fills: number
  padding: number
  available: number
  lastHResult: number
  errors: number
}

export interface WasapiStatus {
  open: boolean
  playing?: boolean
  /** True when the producer starved and the stream parked itself. */
  starved?: boolean
  positionFrames?: number
  bufferedFrames?: number
  ringCapacityFrames?: number
  deviceBufferFrames?: number
  /** Frames rendered as silence because the producer stalled. */
  silenceFrames?: number
  format?: WasapiNegotiatedFormat
  debug?: WasapiDebugInfo
}

export interface WasapiDevicesResult {
  supported: boolean
  devices: WasapiDeviceInfo[]
  error?: string
  addonPath?: string
}

export interface WasapiPlaybackInfo {
  /** True while the exclusive engine owns audio output. */
  active: boolean
  deviceId: string | null
  deviceName: string | null
  format: WasapiNegotiatedFormat | null
  /** True when the decoded samples reach the endpoint without resampling. */
  bitPerfect: boolean
  sourceSampleRate: number
  sourceBits: number | null
  /** True when the content had to be resampled to a rate the device accepts. */
  resampled: boolean
  error: string | null
}

export const EMPTY_WASAPI_PLAYBACK_INFO: WasapiPlaybackInfo = {
  active: false,
  deviceId: null,
  deviceName: null,
  format: null,
  bitPerfect: false,
  sourceSampleRate: 0,
  sourceBits: null,
  resampled: false,
  error: null,
}

/** Extracts the native endpoint id from a device id exposed to the UI. */
export function getWasapiEndpointId(deviceId: string | null | undefined): string | null {
  if (!deviceId || !deviceId.startsWith(WASAPI_DEVICE_PREFIX)) return null
  const endpointId = deviceId.slice(WASAPI_DEVICE_PREFIX.length)
  return endpointId.length > 0 ? endpointId : null
}

export function buildWasapiDeviceId(endpointId: string): string {
  return `${WASAPI_DEVICE_PREFIX}${endpointId}`
}

export function describeWasapiFormat(format: WasapiNegotiatedFormat | null | undefined): string {
  if (!format) return ''
  const depth = format.isFloat ? `${format.bits}bit float` : `${format.validBits}bit`
  return `${format.sampleRate / 1000}kHz / ${depth} / ${format.channels}ch`
}
