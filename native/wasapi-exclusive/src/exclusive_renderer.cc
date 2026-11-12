#include "exclusive_renderer.h"

#include <algorithm>
#include <chrono>
#include <cmath>

#include "device_enumerator.h"

namespace wasapi {
namespace {

// Keeps NaN out of the integer conversion math and bounds the signal to the
// nominal float range.
inline float Sanitize(float value) {
  if (!(value == value)) return 0.0f;
  if (value > 1.0f) return 1.0f;
  if (value < -1.0f) return -1.0f;
  return value;
}

// Maps interleaved float32 samples onto the negotiated PCM container.  The
// scaling factors are exact powers of two so 16/24 bit integer sources survive
// the Web Audio float round-trip bit for bit.
void ConvertFloatToPcm(
    const float* source,
    uint8_t* destination,
    size_t sampleCount,
    const FormatSpec& format) {
  if (format.isFloat) {
    std::memcpy(destination, source, sampleCount * sizeof(float));
    return;
  }

  if (format.bits == 16) {
    auto* out = reinterpret_cast<int16_t*>(destination);
    for (size_t i = 0; i < sampleCount; ++i) {
      long value = std::lrint(Sanitize(source[i]) * 32768.0f);
      if (value > 32767) value = 32767;
      if (value < -32768) value = -32768;
      out[i] = static_cast<int16_t>(value);
    }
    return;
  }

  if (format.bits == 24) {
    for (size_t i = 0; i < sampleCount; ++i) {
      long value = std::lrint(Sanitize(source[i]) * 8388608.0f);
      if (value > 8388607) value = 8388607;
      if (value < -8388608) value = -8388608;
      const uint32_t raw = static_cast<uint32_t>(value) & 0x00FFFFFFu;
      destination[i * 3 + 0] = static_cast<uint8_t>(raw & 0xFF);
      destination[i * 3 + 1] = static_cast<uint8_t>((raw >> 8) & 0xFF);
      destination[i * 3 + 2] = static_cast<uint8_t>((raw >> 16) & 0xFF);
    }
    return;
  }

  if (format.bits == 32) {
    auto* out = reinterpret_cast<int32_t*>(destination);
    if (format.validBits == 24) {
      // 24 bit samples stored left justified in a 32 bit container.
      for (size_t i = 0; i < sampleCount; ++i) {
        long value = std::lrint(Sanitize(source[i]) * 8388608.0f);
        if (value > 8388607) value = 8388607;
        if (value < -8388608) value = -8388608;
        out[i] = static_cast<int32_t>(value << 8);
      }
      return;
    }
    for (size_t i = 0; i < sampleCount; ++i) {
      long long value = std::llrint(static_cast<double>(Sanitize(source[i])) * 2147483648.0);
      if (value > 2147483647LL) value = 2147483647LL;
      if (value < -2147483648LL) value = -2147483648LL;
      out[i] = static_cast<int32_t>(value);
    }
    return;
  }

  std::memset(destination, 0, sampleCount * (format.bits / 8));
}

UINT32 ClampFrames(UINT32 frames, UINT32 limit) {
  return frames > limit ? limit : frames;
}

}  // namespace

// ---------------------------------------------------------------------------
// AudioRing
// ---------------------------------------------------------------------------

void AudioRing::Resize(size_t bytes) {
  std::lock_guard<std::mutex> lock(mutex_);
  buffer_.assign(bytes, 0);
  capacity_ = bytes;
  read_ = 0;
  write_ = 0;
  size_ = 0;
}

size_t AudioRing::CapacityBytes() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return capacity_;
}

size_t AudioRing::SizeBytes() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return size_;
}

size_t AudioRing::WriteBytes(const uint8_t* source, size_t count) {
  if (!source || count == 0) return 0;
  std::lock_guard<std::mutex> lock(mutex_);
  if (capacity_ == 0) return 0;
  count = std::min(count, capacity_ - size_);
  if (count == 0) return 0;
  const size_t first = std::min(count, capacity_ - write_);
  std::memcpy(buffer_.data() + write_, source, first);
  if (count > first) {
    std::memcpy(buffer_.data(), source + first, count - first);
  }
  write_ = (write_ + count) % capacity_;
  size_ += count;
  return count;
}

size_t AudioRing::ReadBytes(uint8_t* destination, size_t count) {
  if (!destination || count == 0) return 0;
  std::lock_guard<std::mutex> lock(mutex_);
  if (capacity_ == 0) return 0;
  count = std::min(count, size_);
  if (count == 0) return 0;
  const size_t first = std::min(count, capacity_ - read_);
  std::memcpy(destination, buffer_.data() + read_, first);
  if (count > first) {
    std::memcpy(destination + first, buffer_.data(), count - first);
  }
  read_ = (read_ + count) % capacity_;
  size_ -= count;
  return count;
}

void AudioRing::Clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  read_ = 0;
  write_ = 0;
  size_ = 0;
}

// ---------------------------------------------------------------------------
// ExclusiveRenderer
// ---------------------------------------------------------------------------

ExclusiveRenderer::ExclusiveRenderer() = default;

ExclusiveRenderer::~ExclusiveRenderer() {
  Close();
}

ExclusiveRenderer* ExclusiveRenderer::Open(
    const OpenRequest& request, OpenResult* result, WasapiError* error) {
  if (request.deviceId.empty()) {
    *error = WasapiError{"DEVICE_NOT_FOUND", "no audio endpoint id was supplied"};
    return nullptr;
  }

  ExclusiveRenderer* renderer = new ExclusiveRenderer();
  renderer->request_ = request;
  renderer->deviceId_ = request.deviceId;
  renderer->requestedBufferMs_ = request.bufferMs == 0 ? 100 : request.bufferMs;
  renderer->ringSeconds_ = request.ringSeconds == 0 ? 1 : request.ringSeconds;

  renderer->initEvent_ = ::CreateEventW(nullptr, TRUE, FALSE, nullptr);
  renderer->renderEvent_ = ::CreateEventW(nullptr, FALSE, FALSE, nullptr);
  renderer->commandEvent_ = ::CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!renderer->initEvent_ || !renderer->renderEvent_ || !renderer->commandEvent_) {
    *error = WasapiError{"RESOURCE_ERROR", "unable to create the audio synchronization events"};
    delete renderer;
    return nullptr;
  }

  renderer->running_.store(true);
  renderer->thread_ = std::thread(&ExclusiveRenderer::ThreadMain, renderer);

  const DWORD wait = ::WaitForSingleObject(renderer->initEvent_, 10000);
  if (wait != WAIT_OBJECT_0 || !renderer->initSucceeded_) {
    if (wait != WAIT_OBJECT_0) {
      *error = WasapiError{"TIMEOUT", "the audio endpoint did not finish initializing"};
    } else {
      *error = renderer->initError_;
      if (error->message.empty()) {
        *error = WasapiError{"ENDPOINT_CREATE_FAILED", "the audio endpoint could not be opened"};
      }
    }
    renderer->Close();
    delete renderer;
    return nullptr;
  }

  if (result) {
    result->format = renderer->format_;
    result->deviceBufferFrames = renderer->deviceBufferFrames_;
    result->ringCapacityFrames = renderer->ringCapacityFrames_.load();
    result->blockAlign = renderer->blockAlign_;
    result->deviceName = renderer->deviceName_;
  }
  return renderer;
}

void ExclusiveRenderer::ThreadMain() {
  ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  DWORD taskIndex = 0;
  HANDLE mmcss = ::AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

  WasapiError error;
  if (InitializeStream(&error)) {
    initSucceeded_ = true;
  } else {
    initError_ = error;
    initSucceeded_ = false;
    running_.store(false);
  }
  ::SetEvent(initEvent_);

  if (initSucceeded_) {
    HANDLE handles[2] = {renderEvent_, commandEvent_};
    while (running_.load()) {
      const DWORD wait = ::WaitForMultipleObjects(2, handles, FALSE, 200);
      if (!running_.load()) break;
      if (wait == WAIT_OBJECT_0) {
        FillDeviceBuffer();
        UpdatePosition();
      } else if (wait == WAIT_OBJECT_0 + 1) {
        ExecutePendingCommand();
        UpdatePosition();
      } else {
        UpdatePosition();
      }
    }
  }

  playing_ = false;
  playingFlag_.store(false);

  // Interfaces must be released on the thread that created them.
  client_.Reset();
  renderClient_.Reset();
  clock_.Reset();
  endpointVolume_.Reset();
  device_.Reset();
  ring_.Clear();

  if (mmcss) {
    ::AvRevertMmThreadCharacteristics(mmcss);
  }
  ::CoUninitialize();
}

bool ExclusiveRenderer::InitializeStream(WasapiError* error) {
  if (!OpenRenderDevice(deviceId_, device_.Put(), error)) return false;
  deviceName_ = ReadFriendlyName(device_.Get());
  if (deviceName_.empty()) deviceName_ = "Audio device";

  if (!ActivateClient(error)) return false;

  std::vector<uint8_t> waveFormat;
  if (!NegotiateFormat(&waveFormat, error)) return false;
  waveFormatBlob_ = waveFormat;

  if (!InitializeClient(waveFormat, error)) return false;

  HRESULT hr = client_->GetBufferSize(&deviceBufferFrames_);
  if (FAILED(hr) || deviceBufferFrames_ == 0) {
    *error = MakeError(FAILED(hr) ? hr : E_FAIL, "unable to read the endpoint buffer size");
    return false;
  }

  hr = client_->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(renderClient_.Put()));
  if (FAILED(hr) || !renderClient_) {
    *error = MakeError(FAILED(hr) ? hr : E_NOINTERFACE, "the endpoint does not expose a render client");
    return false;
  }

  hr = client_->GetService(__uuidof(IAudioClock), reinterpret_cast<void**>(clock_.Put()));
  if (FAILED(hr)) {
    clock_.Reset();
  }
  if (clock_) {
    UINT64 frequency = 0;
    if (SUCCEEDED(clock_->GetFrequency(&frequency)) && frequency > 0) {
      clockFrequency_ = frequency;
    }
  }

  hr = client_->SetEventHandle(renderEvent_);
  if (FAILED(hr)) {
    *error = MakeError(hr, "unable to attach the render event to the audio endpoint");
    return false;
  }

  // Endpoint volume gives the user volume control without touching the PCM
  // samples, so the output stays bit perfect.  Not every driver exposes it in
  // exclusive mode; the renderer degrades to "volume chip disabled" then.
  if (device_) {
    hr = device_->Activate(
        __uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr,
        reinterpret_cast<void**>(endpointVolume_.Put()));
    if (FAILED(hr)) endpointVolume_.Reset();
  }

  const uint32_t ringFrames = std::max<uint32_t>(
      static_cast<uint32_t>(sampleRate_ * ringSeconds_),
      deviceBufferFrames_ * 4);
  ring_.Resize(static_cast<size_t>(ringFrames) * blockAlign_);

  deviceBufferFramesShared_.store(deviceBufferFrames_);
  ringCapacityFrames_.store(ringFrames);
  positionFrames_.store(0);
  submittedFrames_.store(0);
  silenceFrames_.store(0);
  contentFrames_ = 0;
  positionOffset_ = 0;
  emptyStreak_ = 0;
  starved_ = false;
  starvedFlag_.store(false);
  return true;
}

bool ExclusiveRenderer::ActivateClient(WasapiError* error) {
  if (!device_) {
    *error = WasapiError{"DEVICE_NOT_FOUND", "the audio endpoint is no longer available"};
    return false;
  }
  HRESULT hr = device_->Activate(
      __uuidof(IAudioClient), CLSCTX_ALL, nullptr,
      reinterpret_cast<void**>(client_.Put()));
  if (FAILED(hr) || !client_) {
    *error = MakeError(FAILED(hr) ? hr : E_NOINTERFACE, "unable to activate the audio client");
    return false;
  }
  return true;
}

bool ExclusiveRenderer::NegotiateFormat(std::vector<uint8_t>* waveFormat, WasapiError* error) {
  std::vector<FormatSpec> candidates = request_.formats;
  if (candidates.empty()) {
    FormatSpec fallback;
    fallback.sampleRate = request_.sampleRate;
    fallback.channels = request_.channels;
    candidates.push_back(fallback);
  }

  HRESULT lastResult = AUDCLNT_E_UNSUPPORTED_FORMAT;
  for (const FormatSpec& candidate : candidates) {
    FormatSpec spec = candidate;
    spec.sampleRate = request_.sampleRate;
    spec.channels = request_.channels;
    if (spec.validBits == 0) spec.validBits = spec.bits;

    std::vector<uint8_t> blob;
    WasapiError buildError;
    if (!BuildWaveFormat(spec, &blob, &buildError)) {
      *error = buildError;
      return false;
    }

    const HRESULT hr = client_->IsFormatSupported(
        AUDCLNT_SHAREMODE_EXCLUSIVE, WaveFormatPointer(blob), nullptr);
    if (hr == S_OK) {
      format_ = spec;
      sampleRate_ = spec.sampleRate;
      channels_ = spec.channels;
      containerBits_ = spec.bits;
      validBits_ = spec.validBits;
      isFloat_ = spec.isFloat;
      blockAlign_ = spec.BlockAlign();
      bytesPerSample_ = static_cast<uint32_t>(spec.bits / 8);
      *waveFormat = std::move(blob);
      return true;
    }
    lastResult = hr;
  }

  *error = MakeError(
      lastResult,
      "the endpoint does not support the requested sample rate / bit depth in exclusive mode");
  error->code = "UNSUPPORTED_FORMAT";
  return false;
}

bool ExclusiveRenderer::InitializeClient(
    const std::vector<uint8_t>& waveFormat, WasapiError* error) {
  const WAVEFORMATEX* format = WaveFormatPointer(waveFormat);
  REFERENCE_TIME bufferDuration = static_cast<REFERENCE_TIME>(requestedBufferMs_) * 10000;
  REFERENCE_TIME periodicity = bufferDuration;
  HRESULT lastResult = E_FAIL;

  // Exclusive mode drivers are picky about the period / buffer relationship and
  // about buffer alignment.  Try the documented combinations before giving up.
  for (int attempt = 0; attempt < 5; ++attempt) {
    if (!client_ && !ActivateClient(error)) return false;

    lastResult = client_->Initialize(
        AUDCLNT_SHAREMODE_EXCLUSIVE,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        bufferDuration,
        periodicity,
        format,
        nullptr);
    if (SUCCEEDED(lastResult)) return true;

    if (lastResult == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
      UINT32 alignedFrames = 0;
      if (FAILED(client_->GetBufferSize(&alignedFrames)) || alignedFrames == 0) {
        *error = MakeError(lastResult, "the endpoint rejected the requested buffer size");
        return false;
      }
      bufferDuration = static_cast<REFERENCE_TIME>(
          10000.0 * 1000.0 * static_cast<double>(alignedFrames) /
              static_cast<double>(sampleRate_) + 0.5);
      periodicity = bufferDuration;
      client_.Reset();
      continue;
    }

    if (lastResult == E_INVALIDARG && attempt == 0) {
      // Some drivers want the periodicity explicitly set to zero.
      periodicity = 0;
      continue;
    }
    if (lastResult == E_INVALIDARG && attempt == 1) {
      // ... and a few only accept the endpoint default buffer.
      bufferDuration = 0;
      periodicity = 0;
      continue;
    }
    break;
  }

  *error = MakeError(lastResult, "IAudioClient::Initialize failed for exclusive mode");
  return false;
}

bool ExclusiveRenderer::RecreateClient(bool* wasPlaying, WasapiError* error) {
  if (wasPlaying) *wasPlaying = playing_;
  playing_ = false;
  playingFlag_.store(false);

  if (client_) {
    client_->Stop();
  }
  client_.Reset();
  renderClient_.Reset();
  clock_.Reset();

  if (!ActivateClient(error)) return false;
  if (!InitializeClient(waveFormatBlob_, error)) return false;

  HRESULT hr = client_->GetBufferSize(&deviceBufferFrames_);
  if (FAILED(hr) || deviceBufferFrames_ == 0) {
    *error = MakeError(FAILED(hr) ? hr : E_FAIL, "unable to read the endpoint buffer size");
    return false;
  }
  hr = client_->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(renderClient_.Put()));
  if (FAILED(hr) || !renderClient_) {
    *error = MakeError(FAILED(hr) ? hr : E_NOINTERFACE, "the endpoint does not expose a render client");
    return false;
  }
  hr = client_->GetService(__uuidof(IAudioClock), reinterpret_cast<void**>(clock_.Put()));
  if (FAILED(hr)) clock_.Reset();
  if (clock_) {
    UINT64 frequency = 0;
    if (SUCCEEDED(clock_->GetFrequency(&frequency)) && frequency > 0) {
      clockFrequency_ = frequency;
    }
  }
  hr = client_->SetEventHandle(renderEvent_);
  if (FAILED(hr)) {
    *error = MakeError(hr, "unable to attach the render event to the audio endpoint");
    return false;
  }

  deviceBufferFramesShared_.store(deviceBufferFrames_);
  return true;
}

void ExclusiveRenderer::FillDeviceBuffer() {
  if (!playing_ || !client_ || !renderClient_ || deviceBufferFrames_ == 0) return;

  debugEventCount_.fetch_add(1);

  // In exclusive mode IAudioClient::GetCurrentPadding reports the buffer as
  // "full" even when the engine is waiting for its first block, so the shared
  // mode padding math cannot be used.  The event callback means "hand over the
  // next full block".
  const UINT32 frames = deviceBufferFrames_;
  const UINT32 framesFromRing = static_cast<UINT32>(std::min<size_t>(
      frames, ring_.SizeBytes() / static_cast<size_t>(blockAlign_)));

  if (framesFromRing == 0) {
    // Producer starved (throttled renderer timers, slow decode, GC pause...).
    if (emptyStreak_ == 0) {
      // First empty event: submit exactly one silence block so the audio that
      // is already queued in the device still plays out.  Stopping right here
      // would discard up to one device buffer of real samples.
      emptyStreak_ = 1;
      BYTE* data = nullptr;
      const HRESULT result = renderClient_->GetBuffer(frames, &data);
      if (FAILED(result) || !data) {
        debugLastHr_.store(static_cast<int32_t>(result));
        debugErrorCount_.fetch_add(1);
        return;
      }
      std::memset(data, 0, static_cast<size_t>(frames) * blockAlign_);
      renderClient_->ReleaseBuffer(frames, 0);
      silenceFrames_.fetch_add(frames);
      submittedFrames_.fetch_add(frames);
      // The queued silence must not advance the content position.
      positionOffset_ -= static_cast<int64_t>(frames);
      return;
    }

    // Second consecutive empty event: the grace block (and everything queued
    // before it) has been played.  Park the stream so IAudioClock freezes on the
    // audio content instead of running through silence.
    emptyStreak_ = 2;
    UpdatePosition();
    positionOffset_ = static_cast<int64_t>(contentFrames_)
        - (static_cast<int64_t>(debugRawClock_.load()) - static_cast<int64_t>(clockBase_));
    positionFrames_.store(contentFrames_);
    starved_ = true;
    starvedFlag_.store(true);
    playing_ = false;
    playingFlag_.store(false);
    if (client_) client_->Stop();
    return;
  }
  emptyStreak_ = 0;

  BYTE* data = nullptr;
  const HRESULT result = renderClient_->GetBuffer(frames, &data);
  if (FAILED(result) || !data) {
    debugLastHr_.store(static_cast<int32_t>(result));
    debugErrorCount_.fetch_add(1);
    return;
  }

  ring_.ReadBytes(data, static_cast<size_t>(framesFromRing) * blockAlign_);
  contentFrames_ += framesFromRing;
  debugDataFrames_.fetch_add(framesFromRing);
  if (framesFromRing < frames) {
    // Only the very last block of a track can be partially filled; pad its tail
    // so a full block is always released (a partial release may replay stale
    // samples).  The tail padding does not advance the content position.
    std::memset(
        data + static_cast<size_t>(framesFromRing) * blockAlign_,
        0,
        static_cast<size_t>(frames - framesFromRing) * blockAlign_);
    const uint32_t padding = frames - framesFromRing;
    silenceFrames_.fetch_add(padding);
    positionOffset_ -= static_cast<int64_t>(padding);
  }
  renderClient_->ReleaseBuffer(frames, 0);

  debugPadding_.store(framesFromRing);
  debugAvailable_.store(frames);
  debugFillCount_.fetch_add(1);
  submittedFrames_.fetch_add(frames);
}

void ExclusiveRenderer::UpdatePosition() {
  if (!clock_) return;
  UINT64 rawPosition = 0;
  UINT64 qpcPosition = 0;
  if (FAILED(clock_->GetPosition(&rawPosition, &qpcPosition))) return;

  uint64_t frames = rawPosition;
  if (clockFrequency_ > 0 && clockFrequency_ != sampleRate_) {
    frames = static_cast<uint64_t>(std::llround(
        static_cast<double>(rawPosition) * static_cast<double>(sampleRate_) /
        static_cast<double>(clockFrequency_)));
  }

  if (!clockBaseCaptured_) {
    clockBase_ = frames;
    clockBaseCaptured_ = true;
    debugClockBase_.store(clockBase_);
  }
  debugRawClock_.store(frames);
  const int64_t adjusted =
      static_cast<int64_t>(frames) - static_cast<int64_t>(clockBase_) + positionOffset_;
  positionFrames_.store(adjusted > 0 ? static_cast<uint64_t>(adjusted) : 0);
}

void ExclusiveRenderer::ExecutePendingCommand() {
  std::function<HRESULT()> command;
  {
    std::lock_guard<std::mutex> lock(commandMutex_);
    command = std::move(pendingCommand_);
    pendingCommand_ = nullptr;
    commandPending_ = false;
  }

  HRESULT result = E_FAIL;
  if (command) result = command();

  {
    std::lock_guard<std::mutex> lock(commandMutex_);
    commandResult_ = result;
    commandDone_ = true;
  }
  commandCv_.notify_all();
}

HRESULT ExclusiveRenderer::RunOnThread(const std::function<HRESULT()>& command) {
  if (!thread_.joinable() || !running_.load()) return E_FAIL;

  {
    std::lock_guard<std::mutex> lock(commandMutex_);
    if (commandPending_) return E_FAIL;
    pendingCommand_ = command;
    commandPending_ = true;
    commandDone_ = false;
    commandResult_ = E_FAIL;
    commandError_ = WasapiError{};
  }
  ::SetEvent(commandEvent_);

  std::unique_lock<std::mutex> lock(commandMutex_);
  if (!commandCv_.wait_for(lock, std::chrono::seconds(5), [this] { return commandDone_; })) {
    commandError_ = WasapiError{"TIMEOUT", "the audio thread did not acknowledge the command"};
    return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
  }
  return commandResult_;
}

bool ExclusiveRenderer::WriteFloat32(
    const float* samples, uint32_t frames, uint32_t* accepted, WasapiError* error) {
  if (accepted) *accepted = 0;
  if (!samples || frames == 0) return true;
  if (blockAlign_ == 0) {
    *error = WasapiError{"NOT_INITIALIZED", "the exclusive stream is not initialized"};
    return false;
  }

  const size_t capacity = ring_.CapacityBytes();
  const size_t roomFrames = ring_.CapacityBytes() == 0
      ? 0
      : (capacity - ring_.SizeBytes()) / blockAlign_;
  const uint32_t writable = static_cast<uint32_t>(std::min<size_t>(frames, roomFrames));
  if (writable == 0) return true;

  convertScratch_.resize(static_cast<size_t>(writable) * blockAlign_);
  ConvertFloatToPcm(
      samples,
      convertScratch_.data(),
      static_cast<size_t>(writable) * channels_,
      format_);
  const size_t written = ring_.WriteBytes(convertScratch_.data(), convertScratch_.size());
  if (accepted) *accepted = static_cast<uint32_t>(written / blockAlign_);
  return true;
}

uint32_t ExclusiveRenderer::BufferedFrames() const {
  if (blockAlign_ == 0) return 0;
  return static_cast<uint32_t>(ring_.SizeBytes() / blockAlign_);
}

uint32_t ExclusiveRenderer::RingCapacityFrames() const {
  return ringCapacityFrames_.load();
}

uint32_t ExclusiveRenderer::DeviceBufferFrames() const {
  return deviceBufferFramesShared_.load();
}

uint64_t ExclusiveRenderer::PositionFrames() const {
  return positionFrames_.load();
}

uint64_t ExclusiveRenderer::SilenceFrames() const {
  return silenceFrames_.load();
}

ExclusiveRenderer::Diagnostics ExclusiveRenderer::GetDiagnostics() const {
  Diagnostics diagnostics;
  diagnostics.events = debugEventCount_.load();
  diagnostics.fills = debugFillCount_.load();
  diagnostics.padding = debugPadding_.load();
  diagnostics.available = debugAvailable_.load();
  diagnostics.lastHResult = debugLastHr_.load();
  diagnostics.errors = debugErrorCount_.load();
  diagnostics.dataFrames = debugDataFrames_.load();
  diagnostics.clockBase = debugClockBase_.load();
  diagnostics.rawClock = debugRawClock_.load();
  return diagnostics;
}

bool ExclusiveRenderer::Pause(WasapiError* error) {
  const HRESULT hr = RunOnThread([this]() -> HRESULT {
    if (!client_) return E_FAIL;
    if (playing_) {
      const HRESULT stopResult = client_->Stop();
      if (FAILED(stopResult)) {
        commandError_ = MakeError(stopResult, "unable to stop the exclusive stream");
        return stopResult;
      }
      playing_ = false;
      playingFlag_.store(false);
    }
    UpdatePosition();
    return S_OK;
  });
  if (FAILED(hr)) {
    if (error) *error = commandError_;
    return false;
  }
  return true;
}

bool ExclusiveRenderer::Resume(WasapiError* error) {
  const HRESULT hr = RunOnThread([this]() -> HRESULT {
    if (!client_) return E_FAIL;
    if (!playing_) {
      const HRESULT startResult = client_->Start();
      if (FAILED(startResult)) {
        commandError_ = MakeError(startResult, "unable to start the exclusive stream");
        return startResult;
      }
      playing_ = true;
      playingFlag_.store(true);
      starved_ = false;
      starvedFlag_.store(false);
      emptyStreak_ = 0;
    }
    return S_OK;
  });
  if (FAILED(hr)) {
    if (error) *error = commandError_;
    return false;
  }
  return true;
}

bool ExclusiveRenderer::Reset(WasapiError* error) {
  const HRESULT hr = RunOnThread([this]() -> HRESULT {
    if (!client_) return E_FAIL;

    if (playing_) {
      client_->Stop();
      playing_ = false;
      playingFlag_.store(false);
    }

    HRESULT resetResult = client_->Reset();
    if (FAILED(resetResult)) {
      // Not every exclusive-mode driver implements IAudioClient::Reset; rebuild
      // the stream so the seek still lands on a clean buffer.
      WasapiError recreateError;
      bool ignored = false;
      if (!RecreateClient(&ignored, &recreateError)) {
        commandError_ = recreateError;
        return E_FAIL;
      }
      resetResult = S_OK;
    }

    ring_.Clear();
    submittedFrames_.store(0);
    silenceFrames_.store(0);
    contentFrames_ = 0;
    positionOffset_ = 0;
    emptyStreak_ = 0;
    starved_ = false;
    starvedFlag_.store(false);
    clockBaseCaptured_ = false;
    clockBase_ = 0;
    positionFrames_.store(0);
    UpdatePosition();
    return resetResult;
  });

  if (FAILED(hr)) {
    if (error) *error = commandError_;
    return false;
  }
  return true;
}

bool ExclusiveRenderer::GetVolume(float* scalar, bool* mute, WasapiError* error) {
  float localScalar = 1.0f;
  bool localMute = false;
  const HRESULT hr = RunOnThread([this, &localScalar, &localMute]() -> HRESULT {
    if (!endpointVolume_) {
      commandError_ = WasapiError{"VOLUME_UNSUPPORTED", "the endpoint does not expose hardware volume"};
      return E_NOTIMPL;
    }
    HRESULT result = endpointVolume_->GetMasterVolumeLevelScalar(&localScalar);
    if (FAILED(result)) {
      commandError_ = MakeError(result, "unable to read the endpoint volume");
      return result;
    }
    BOOL muteFlag = FALSE;
    result = endpointVolume_->GetMute(&muteFlag);
    if (FAILED(result)) {
      commandError_ = MakeError(result, "unable to read the endpoint mute state");
      return result;
    }
    localMute = muteFlag != FALSE;
    return S_OK;
  });
  if (FAILED(hr)) {
    if (error) *error = commandError_;
    return false;
  }
  if (scalar) *scalar = localScalar;
  if (mute) *mute = localMute;
  return true;
}

bool ExclusiveRenderer::SetVolume(float scalar, bool mute, WasapiError* error) {
  if (scalar < 0.0f) scalar = 0.0f;
  if (scalar > 1.0f) scalar = 1.0f;
  const HRESULT hr = RunOnThread([this, scalar, mute]() -> HRESULT {
    if (!endpointVolume_) {
      commandError_ = WasapiError{"VOLUME_UNSUPPORTED", "the endpoint does not expose hardware volume"};
      return E_NOTIMPL;
    }
    HRESULT result = endpointVolume_->SetMasterVolumeLevelScalar(scalar, nullptr);
    if (FAILED(result)) {
      commandError_ = MakeError(result, "unable to change the endpoint volume");
      return result;
    }
    result = endpointVolume_->SetMute(mute ? TRUE : FALSE, nullptr);
    if (FAILED(result)) {
      commandError_ = MakeError(result, "unable to change the endpoint mute state");
      return result;
    }
    return S_OK;
  });
  if (FAILED(hr)) {
    if (error) *error = commandError_;
    return false;
  }
  return true;
}

void ExclusiveRenderer::Close() {
  if (!running_.exchange(false)) {
    if (thread_.joinable()) thread_.join();
    if (initEvent_) ::CloseHandle(initEvent_);
    if (renderEvent_) ::CloseHandle(renderEvent_);
    if (commandEvent_) ::CloseHandle(commandEvent_);
    initEvent_ = nullptr;
    renderEvent_ = nullptr;
    commandEvent_ = nullptr;
    return;
  }

  if (renderEvent_) ::SetEvent(renderEvent_);
  if (commandEvent_) ::SetEvent(commandEvent_);
  if (thread_.joinable()) thread_.join();

  if (initEvent_) ::CloseHandle(initEvent_);
  if (renderEvent_) ::CloseHandle(renderEvent_);
  if (commandEvent_) ::CloseHandle(commandEvent_);
  initEvent_ = nullptr;
  renderEvent_ = nullptr;
  commandEvent_ = nullptr;
}

}  // namespace wasapi
