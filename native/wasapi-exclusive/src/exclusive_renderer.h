// WASAPI exclusive-mode renderer.
//
// One ExclusiveRenderer owns a single IAudioClient opened in
// AUDCLNT_SHAREMODE_EXCLUSIVE and a dedicated render thread.  Every device
// operation (open / start / stop / reset / volume / clock reads) happens on that
// thread so the COM interfaces never cross apartments.
//
// The JavaScript side pushes interleaved float32 PCM into a lock-free-ish ring
// buffer; the render thread converts it to the negotiated sample format and
// hands it to the audio engine one device buffer at a time.
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "wasapi_common.h"

namespace wasapi {

struct OpenRequest {
  std::string deviceId;
  uint32_t sampleRate = 48000;
  uint16_t channels = 2;
  // Formats to try, in order.  All entries must share sampleRate/channels.
  std::vector<FormatSpec> formats;
  uint32_t bufferMs = 100;
  uint32_t ringSeconds = 1;
};

struct OpenResult {
  FormatSpec format;
  uint32_t deviceBufferFrames = 0;
  uint32_t ringCapacityFrames = 0;
  uint32_t blockAlign = 0;
  std::string deviceName;
};

class AudioRing {
 public:
  void Resize(size_t bytes);
  size_t CapacityBytes() const;
  size_t SizeBytes() const;
  size_t WriteBytes(const uint8_t* source, size_t count);
  size_t ReadBytes(uint8_t* destination, size_t count);
  void Clear();

 private:
  mutable std::mutex mutex_;
  std::vector<uint8_t> buffer_;
  size_t capacity_ = 0;
  size_t read_ = 0;
  size_t write_ = 0;
  size_t size_ = 0;
};

class ExclusiveRenderer {
 public:
  // Spawns the render thread, opens the endpoint and waits for the stream to be
  // initialized.  Returns nullptr and fills `error` on failure.
  static ExclusiveRenderer* Open(
      const OpenRequest& request, OpenResult* result, WasapiError* error);

  ~ExclusiveRenderer();

  bool WriteFloat32(const float* samples, uint32_t frames, uint32_t* accepted, WasapiError* error);
  uint32_t BufferedFrames() const;
  uint32_t RingCapacityFrames() const;
  uint32_t DeviceBufferFrames() const;
  uint64_t PositionFrames() const;
  // Number of frames rendered as silence because the producer ran dry.  The
  // renderer subtracts this from the device clock so progress/lyrics stay
  // aligned with the audible content after a starvation.
  uint64_t SilenceFrames() const;
  FormatSpec Format() const { return format_; }
  bool IsPlaying() const { return playingFlag_.load(); }
  // True after the producer ran dry and the stream parked itself.  The next
  // write() + resume() continues exactly where the audio content stopped.
  bool Starved() const { return starvedFlag_.load(); }

  struct Diagnostics {
    uint64_t events = 0;
    uint64_t fills = 0;
    uint32_t padding = 0;
    uint32_t available = 0;
    int32_t lastHResult = 0;
    uint32_t errors = 0;
    uint64_t dataFrames = 0;
    uint64_t clockBase = 0;
    uint64_t rawClock = 0;
  };
  Diagnostics GetDiagnostics() const;

  bool Pause(WasapiError* error);
  bool Resume(WasapiError* error);
  // Stops the stream, drops every queued frame and rewinds the playback clock.
  bool Reset(WasapiError* error);

  bool GetVolume(float* scalar, bool* mute, WasapiError* error);
  bool SetVolume(float scalar, bool mute, WasapiError* error);

  void Close();

 private:
  ExclusiveRenderer();

  void ThreadMain();
  bool InitializeStream(WasapiError* error);
  bool ActivateClient(WasapiError* error);
  bool NegotiateFormat(std::vector<uint8_t>* waveFormat, WasapiError* error);
  bool InitializeClient(const std::vector<uint8_t>& waveFormat, WasapiError* error);
  bool RecreateClient(bool* wasPlaying, WasapiError* error);

  void FillDeviceBuffer();
  void UpdatePosition();
  void ExecutePendingCommand();

  HRESULT RunOnThread(const std::function<HRESULT()>& command);

  // ---- thread owned state -------------------------------------------------
  ComPtr<IMMDevice> device_;
  ComPtr<IAudioClient> client_;
  ComPtr<IAudioRenderClient> renderClient_;
  ComPtr<IAudioClock> clock_;
  ComPtr<IAudioEndpointVolume> endpointVolume_;

  std::vector<uint8_t> waveFormatBlob_;
  std::vector<uint8_t> convertScratch_;

  uint32_t deviceBufferFrames_ = 0;
  uint32_t blockAlign_ = 0;
  uint32_t bytesPerSample_ = 0;
  uint32_t sampleRate_ = 48000;
  uint16_t channels_ = 2;
  uint16_t containerBits_ = 16;
  uint16_t validBits_ = 16;
  bool isFloat_ = false;
  uint64_t clockFrequency_ = 0;
  uint64_t clockBase_ = 0;
  bool clockBaseCaptured_ = false;
  bool playing_ = false;
  bool resetSupported_ = true;
  bool starved_ = false;
  // Consecutive events that found the ring empty (0 = producer healthy).
  int emptyStreak_ = 0;
  // Frames of real audio handed to the device (silence padding excluded).
  uint64_t contentFrames_ = 0;
  // Added to (rawClock - clockBase) so silence padding never advances the
  // reported playback position.  Can be negative while silence is queued.
  int64_t positionOffset_ = 0;

  // ---- shared state -------------------------------------------------------
  AudioRing ring_;
  OpenRequest request_;
  FormatSpec format_;
  std::string deviceName_;
  uint32_t requestedBufferMs_ = 100;
  uint32_t ringSeconds_ = 1;
  std::string deviceId_;

  std::atomic<bool> running_{false};
  std::atomic<bool> playingFlag_{false};
  std::atomic<uint64_t> positionFrames_{0};
  std::atomic<uint64_t> submittedFrames_{0};
  std::atomic<uint32_t> deviceBufferFramesShared_{0};
  std::atomic<uint32_t> ringCapacityFrames_{0};
  std::atomic<uint64_t> silenceFrames_{0};
  std::atomic<bool> starvedFlag_{false};

  // Lightweight diagnostics surfaced through status() for troubleshooting
  // driver specific behaviour (padding reporting, event delivery).
  std::atomic<uint64_t> debugEventCount_{0};
  std::atomic<uint64_t> debugFillCount_{0};
  std::atomic<uint32_t> debugPadding_{0};
  std::atomic<uint32_t> debugAvailable_{0};
  std::atomic<int32_t> debugLastHr_{0};
  std::atomic<uint32_t> debugErrorCount_{0};
  std::atomic<uint64_t> debugDataFrames_{0};
  std::atomic<uint64_t> debugClockBase_{0};
  std::atomic<uint64_t> debugRawClock_{0};

  std::thread thread_;
  HANDLE initEvent_ = nullptr;
  HANDLE renderEvent_ = nullptr;
  HANDLE commandEvent_ = nullptr;
  bool initSucceeded_ = false;
  WasapiError initError_;

  std::mutex commandMutex_;
  std::condition_variable commandCv_;
  std::function<HRESULT()> pendingCommand_;
  bool commandPending_ = false;
  bool commandDone_ = false;
  HRESULT commandResult_ = E_FAIL;
  WasapiError commandError_;
};

}  // namespace wasapi
