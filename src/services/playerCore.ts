type PlayerCoreEventBase = {
  currentSrc: string
}

export type PlayerCoreEvent =
  | ({ type: 'loadstart' } & PlayerCoreEventBase)
  | ({ type: 'loadeddata' } & PlayerCoreEventBase)
  | ({ type: 'canplay' } & PlayerCoreEventBase)
  | ({ type: 'playing' } & PlayerCoreEventBase)
  | ({ type: 'pause' } & PlayerCoreEventBase)
  | ({ type: 'waiting' } & PlayerCoreEventBase)
  | ({ type: 'emptied' } & PlayerCoreEventBase)
  | ({ type: 'ended' } & PlayerCoreEventBase)
  | ({ type: 'timeupdate'; currentTime: number } & PlayerCoreEventBase)
  | ({ type: 'durationchange'; duration: number } & PlayerCoreEventBase)
  | {
      type: 'error'
      error: MediaError | null
      currentSrc: string
      networkState: number
      readyState: number
    }

type PlayerCoreListener = (event: PlayerCoreEvent) => void

export interface PlayerBackendResourceOptions {
  autoplay?: boolean
  startTime?: number
}

/**
 * Pluggable playback sink.  The default implementation is the <audio> element
 * bound through `bind()`; the WASAPI exclusive engine installs itself with
 * `useBackend()` and then owns every playback call while it is active.
 */
export interface PlayerBackend {
  readonly kind: 'element' | 'wasapi'
  setResource(source: string, options?: PlayerBackendResourceOptions): Promise<string>
  play(): Promise<void>
  pause(): void
  stop(): void
  seek(time: number): void
  getCurrentTime(): number
  getDuration(): number
  isEmpty(): boolean
  setVolume(volume: number, muted: boolean): void
  dispose(): void | Promise<void>
}

class PlayerCoreService {
  private audio: HTMLAudioElement | null = null
  private listeners = new Set<PlayerCoreListener>()
  private unsubscribeResourceListeners: (() => void) | null = null
  private backend: PlayerBackend | null = null

  bind(audio: HTMLAudioElement) {
    if (this.audio === audio) return

    this.unsubscribeResourceListeners?.()
    this.unsubscribeResourceListeners = null
    // HMR can re-run the module that owns the zustand handler while the playerCore singleton
    // survives, leaving stale listeners that fire on every DOM event.  Clearing them on each
    // bind keeps us down to the single live listener that setAudioRef is about to attach.
    this.listeners.clear()
    this.audio = audio
    audio.preload = 'auto'
    audio.crossOrigin = 'anonymous'
    audio.setAttribute('crossorigin', 'anonymous')
  }

  subscribe(listener: PlayerCoreListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAudio() {
    return this.audio
  }

  /** Installs (or clears) an alternative playback backend. */
  async useBackend(backend: PlayerBackend | null) {
    const previous = this.backend
    if (previous === backend) return
    this.backend = backend
    if (previous) {
      try {
        await previous.dispose()
      } catch (error) {
        console.warn('[PlayerCore] dispose backend failed:', error)
      }
    }
  }

  getBackend() {
    return this.backend
  }

  isExternalBackend() {
    return this.backend != null
  }

  /** Backends push their synthetic events through here. */
  emitEvent(event: PlayerCoreEvent) {
    this.emit(event)
  }

  isEmpty() {
    if (this.backend) return this.backend.isEmpty()
    return !this.audio?.src
  }

  getCurrentTime() {
    if (this.backend) return this.backend.getCurrentTime()
    return this.audio?.currentTime || 0
  }

  getDuration() {
    if (this.backend) return this.backend.getDuration()
    return this.audio?.duration || 0
  }

  setCurrentTime(time: number) {
    if (this.backend) {
      this.backend.seek(time)
      return
    }
    if (!this.audio) return
    this.audio.currentTime = time
  }

  setVolume(volume: number, muted = false) {
    if (this.backend) {
      this.backend.setVolume(volume, muted)
      return
    }
    if (!this.audio) return
    this.audio.volume = muted ? 0 : volume
  }

  async setResource(
    source: string,
    options?: PlayerBackendResourceOptions,
  ) {
    if (this.backend) {
      return await this.backend.setResource(source, options)
    }

    const audio = this.requireAudio()
    const autoplay = options?.autoplay !== false
    const startTime = typeof options?.startTime === 'number' && Number.isFinite(options.startTime)
      ? Math.max(0, options.startTime)
      : 0

    const applySeek = () => {
      if (!startTime) return
      try {
        audio.currentTime = startTime
      } catch {
        // Ignore seek errors before metadata becomes available.
      }
    }

    const cleanupDeferredSeek = this.attachDeferredSeek(audio, applySeek)

    this.unsubscribeResourceListeners?.()
    this.unsubscribeResourceListeners = this.attachResourceListeners(audio, source)
    audio.src = source
    audio.load()
    applySeek()

    try {
      if (autoplay) {
        await audio.play()
      }
      return source
    } finally {
      cleanupDeferredSeek()
    }
  }

  async play() {
    if (this.backend) {
      await this.backend.play()
      return
    }
    const audio = this.requireAudio()
    await audio.play()
  }

  pause() {
    if (this.backend) {
      this.backend.pause()
      return
    }
    this.audio?.pause()
  }

  stop() {
    if (this.backend) {
      this.backend.stop()
      return
    }
    if (!this.audio) return
    this.audio.pause()
    this.unsubscribeResourceListeners?.()
    this.unsubscribeResourceListeners = null
    this.audio.src = ''
    this.audio.removeAttribute('src')
  }

  private requireAudio() {
    if (!this.audio) {
      throw new Error('Audio element has not been bound')
    }
    return this.audio
  }

  private emit(event: PlayerCoreEvent) {
    this.listeners.forEach((listener) => {
      listener(event)
    })
  }

  private attachDeferredSeek(audio: HTMLAudioElement, callback: () => void) {
    const handleLoadedMetadata = () => callback()
    const handleCanPlay = () => callback()

    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    audio.addEventListener('canplay', handleCanPlay)

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
      audio.removeEventListener('canplay', handleCanPlay)
    }
  }

  private attachResourceListeners(audio: HTMLAudioElement, resourceSrc: string) {
    const handleLoadStart = () => this.emit({ type: 'loadstart', currentSrc: resourceSrc })
    const handleLoadedData = () => this.emit({ type: 'loadeddata', currentSrc: resourceSrc })
    const handleCanPlay = () => this.emit({ type: 'canplay', currentSrc: resourceSrc })
    const handlePlaying = () => this.emit({ type: 'playing', currentSrc: resourceSrc })
    const handlePause = () => this.emit({ type: 'pause', currentSrc: resourceSrc })
    const handleWaiting = () => this.emit({ type: 'waiting', currentSrc: resourceSrc })
    const handleEmptied = () => this.emit({ type: 'emptied', currentSrc: resourceSrc })
    const handleEnded = () => this.emit({ type: 'ended', currentSrc: resourceSrc })
    const handleTimeUpdate = () => this.emit({ type: 'timeupdate', currentSrc: resourceSrc, currentTime: audio.currentTime || 0 })
    const handleDurationChange = () => this.emit({ type: 'durationchange', currentSrc: resourceSrc, duration: audio.duration || 0 })
    const handleError = () => {
      this.emit({
        type: 'error',
        error: audio.error,
        currentSrc: resourceSrc,
        networkState: audio.networkState,
        readyState: audio.readyState,
      })
    }

    audio.addEventListener('loadstart', handleLoadStart)
    audio.addEventListener('loadeddata', handleLoadedData)
    audio.addEventListener('canplay', handleCanPlay)
    audio.addEventListener('playing', handlePlaying)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('waiting', handleWaiting)
    audio.addEventListener('emptied', handleEmptied)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('durationchange', handleDurationChange)
    audio.addEventListener('error', handleError)

    return () => {
      audio.removeEventListener('loadstart', handleLoadStart)
      audio.removeEventListener('loadeddata', handleLoadedData)
      audio.removeEventListener('canplay', handleCanPlay)
      audio.removeEventListener('playing', handlePlaying)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('waiting', handleWaiting)
      audio.removeEventListener('emptied', handleEmptied)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('durationchange', handleDurationChange)
      audio.removeEventListener('error', handleError)
    }
  }
}

export const playerCore = new PlayerCoreService()
export default playerCore
