// Shared helpers for the Sollin WASAPI exclusive output addon.
//
// This file only contains header-only utilities: COM cleanup, UTF-8 conversion,
// HRESULT -> machine readable error code mapping and WAVEFORMATEXTENSIBLE
// construction.  Keeping the platform details here makes the renderer and the
// device enumerator easy to read.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <objbase.h>
#include <propidl.h>
#include <propsys.h>
#include <propvarutil.h>
#include <mmreg.h>
#include <ks.h>
#include <ksmedia.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#include <avrt.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

// CLSID_MMDeviceEnumerator / PKEY_Device_FriendlyName are normally pulled in from
// uuid.lib and Functiondiscoverykeys_devpkey.h.  Defining them locally keeps the
// addon free of extra import libraries and SDK header version differences.
static const CLSID kClsidMMDeviceEnumerator = {
  0xBCDE0395, 0xE52F, 0x467C, {0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}
};

static const PROPERTYKEY kPkeyDeviceFriendlyName = {
  {0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}},
  14
};

static const GUID kSubFormatPcm = {
  0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}
};

static const GUID kSubFormatIeeeFloat = {
  0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}
};

namespace wasapi {

// Sample layout requested from WASAPI exclusive mode.
//   bits       - container size in bits (16 / 24 / 32)
//   validBits  - significant bits inside the container (<= bits)
//   isFloat    - 32 bit IEEE float container
struct FormatSpec {
  uint32_t sampleRate = 48000;
  uint16_t channels = 2;
  uint16_t bits = 16;
  uint16_t validBits = 16;
  bool isFloat = false;

  uint16_t BlockAlign() const {
    return static_cast<uint16_t>(channels * (bits / 8));
  }
};

struct WasapiError {
  std::string code = "WASAPI_ERROR";
  std::string message;
};

// Very small RAII wrapper.  Avoids pulling in a full COM smart pointer header.
template <typename T>
class ComPtr {
 public:
  ComPtr() = default;
  ~ComPtr() { Reset(); }
  ComPtr(const ComPtr&) = delete;
  ComPtr& operator=(const ComPtr&) = delete;

  T* Get() const { return pointer_; }
  T* operator->() const { return pointer_; }
  T** Put() {
    Reset();
    return &pointer_;
  }
  void Reset(T* next = nullptr) {
    if (pointer_) {
      pointer_->Release();
    }
    pointer_ = next;
  }
  T* Detach() {
    T* value = pointer_;
    pointer_ = nullptr;
    return value;
  }
  explicit operator bool() const { return pointer_ != nullptr; }

 private:
  T* pointer_ = nullptr;
};

inline std::string WideToUtf8(const wchar_t* value) {
  if (!value || !*value) return std::string();
  const int length = ::WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (length <= 1) return std::string();
  std::vector<char> buffer(static_cast<size_t>(length), '\0');
  ::WideCharToMultiByte(CP_UTF8, 0, value, -1, buffer.data(), length, nullptr, nullptr);
  return std::string(buffer.data(), static_cast<size_t>(length - 1));
}

inline std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) return std::wstring();
  const int length = ::MultiByteToWideChar(
      CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) return std::wstring();
  std::wstring buffer(static_cast<size_t>(length), L'\0');
  ::MultiByteToWideChar(
      CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), buffer.data(), length);
  return buffer;
}

inline std::string FormatHResult(HRESULT hr) {
  char buffer[32] = {0};
  std::snprintf(buffer, sizeof(buffer), "0x%08lX", static_cast<unsigned long>(hr));
  return std::string(buffer);
}

inline const char* CodeForHResult(HRESULT hr) {
  switch (hr) {
    case AUDCLNT_E_DEVICE_IN_USE: return "DEVICE_IN_USE";
    case AUDCLNT_E_UNSUPPORTED_FORMAT: return "UNSUPPORTED_FORMAT";
    case AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED: return "EXCLUSIVE_MODE_NOT_ALLOWED";
    case AUDCLNT_E_ENDPOINT_CREATE_FAILED: return "ENDPOINT_CREATE_FAILED";
    case AUDCLNT_E_DEVICE_INVALIDATED: return "DEVICE_INVALIDATED";
    case AUDCLNT_E_SERVICE_NOT_RUNNING: return "AUDIO_SERVICE_NOT_RUNNING";
    case AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED: return "BUFFER_SIZE_NOT_ALIGNED";
    case AUDCLNT_E_BUFFER_SIZE_ERROR: return "BUFFER_SIZE_ERROR";
    case AUDCLNT_E_BUFFER_OPERATION_PENDING: return "BUFFER_OPERATION_PENDING";
    case AUDCLNT_E_OUT_OF_ORDER: return "OUT_OF_ORDER";
    case AUDCLNT_E_NOT_STOPPED: return "NOT_STOPPED";
    case AUDCLNT_E_WRONG_ENDPOINT_TYPE: return "WRONG_ENDPOINT_TYPE";
    case AUDCLNT_E_NOT_INITIALIZED: return "NOT_INITIALIZED";
    case E_ACCESSDENIED: return "ACCESS_DENIED";
    case E_OUTOFMEMORY: return "OUT_OF_MEMORY";
    case E_NOTIMPL: return "NOT_IMPLEMENTED";
    case E_INVALIDARG: return "INVALID_ARGUMENT";
    case E_NOINTERFACE: return "INTERFACE_NOT_SUPPORTED";
    case E_POINTER: return "INVALID_POINTER";
    case REGDB_E_CLASSNOTREG: return "AUDIO_ENDPOINT_UNAVAILABLE";
    case HRESULT_FROM_WIN32(ERROR_NOT_FOUND): return "DEVICE_NOT_FOUND";
    case HRESULT_FROM_WIN32(ERROR_TIMEOUT): return "TIMEOUT";
    default: return "WASAPI_ERROR";
  }
}

inline WasapiError MakeError(HRESULT hr, const std::string& context) {
  WasapiError error;
  error.code = CodeForHResult(hr);
  std::string message = context;
  if (!message.empty()) message += ": ";
  message += "HRESULT " + FormatHResult(hr);
  error.message = message;
  return error;
}

// Channel masks expected by WAVEFORMATEXTENSIBLE.  The device rejects a stream
// whose mask does not match one of its supported layouts, so we stick to the
// standard orders.
inline DWORD ChannelMaskFor(uint16_t channels) {
  switch (channels) {
    case 1: return 0x00000004;  // SPEAKER_FRONT_CENTER
    case 2: return 0x00000003;  // FL | FR
    case 3: return 0x00000007;  // FL | FR | FC
    case 4: return 0x00000033;  // FL | FR | BL | BR
    case 5: return 0x00000037;  // FL | FR | FC | BL | BR
    case 6: return 0x0000003F;  // 5.1
    case 7: return 0x0000013F;
    case 8: return 0x0000063F;  // 7.1
    default: return 0;
  }
}

// Builds the WAVEFORMATEX blob handed to IAudioClient.  Plain 16 bit stereo uses
// the legacy WAVEFORMATEX structure because a handful of drivers reject the
// extensible form for the most common CD format.
inline bool BuildWaveFormat(const FormatSpec& spec, std::vector<uint8_t>* out, WasapiError* error) {
  if (!out) return false;
  if (spec.channels == 0 || spec.channels > 8) {
    *error = WasapiError{"UNSUPPORTED_CHANNELS", "channel count must be between 1 and 8"};
    return false;
  }
  if (spec.bits != 16 && spec.bits != 24 && spec.bits != 32) {
    *error = WasapiError{"UNSUPPORTED_BIT_DEPTH", "bit depth must be 16, 24 or 32"};
    return false;
  }
  if (spec.validBits == 0 || spec.validBits > spec.bits) {
    *error = WasapiError{"UNSUPPORTED_BIT_DEPTH", "valid bits must be between 1 and the container size"};
    return false;
  }

  const WORD blockAlign = spec.BlockAlign();
  const DWORD averageBytesPerSecond = spec.sampleRate * blockAlign;

  if (!spec.isFloat && spec.bits == 16 && spec.channels <= 2) {
    WAVEFORMATEX format = {};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = spec.channels;
    format.nSamplesPerSec = spec.sampleRate;
    format.wBitsPerSample = spec.bits;
    format.nBlockAlign = blockAlign;
    format.nAvgBytesPerSec = averageBytesPerSecond;
    format.cbSize = 0;
    out->resize(sizeof(format));
    std::memcpy(out->data(), &format, sizeof(format));
    return true;
  }

  WAVEFORMATEXTENSIBLE format = {};
  format.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  format.Format.nChannels = spec.channels;
  format.Format.nSamplesPerSec = spec.sampleRate;
  format.Format.wBitsPerSample = spec.bits;
  format.Format.nBlockAlign = blockAlign;
  format.Format.nAvgBytesPerSec = averageBytesPerSecond;
  format.Format.cbSize = static_cast<WORD>(sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX));
  format.Samples.wValidBitsPerSample = spec.validBits;
  format.dwChannelMask = ChannelMaskFor(spec.channels);
  format.SubFormat = spec.isFloat ? kSubFormatIeeeFloat : kSubFormatPcm;

  out->resize(sizeof(format));
  std::memcpy(out->data(), &format, sizeof(format));
  return true;
}

inline const WAVEFORMATEX* WaveFormatPointer(const std::vector<uint8_t>& blob) {
  return reinterpret_cast<const WAVEFORMATEX*>(blob.data());
}

// WASAPI exclusive streams need COM initialized on the calling thread.  Electron
// may have initialized the main thread as STA already; in that case COM is
// usable as-is and RPC_E_CHANGED_MODE is not an error for our purposes.
inline void EnsureComInitialized() {
  thread_local bool initialized = false;
  if (initialized) return;
  ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  initialized = true;
}

}  // namespace wasapi
