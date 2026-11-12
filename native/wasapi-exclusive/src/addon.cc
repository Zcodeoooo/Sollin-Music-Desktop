// N-API bindings for the WASAPI exclusive output addon.
//
// The module is intentionally small: a single process-wide exclusive stream plus
// device enumeration / format probing.  All heavy lifting lives in
// ExclusiveRenderer; this file only translates JavaScript values.
#include <node_api.h>

#include <mutex>
#include <string>
#include <vector>

#include "device_enumerator.h"
#include "exclusive_renderer.h"
#include "wasapi_common.h"

namespace {

using wasapi::DeviceInfo;
using wasapi::ExclusiveRenderer;
using wasapi::FormatSpec;
using wasapi::OpenRequest;
using wasapi::OpenResult;
using wasapi::WasapiError;

std::mutex g_sessionMutex;
ExclusiveRenderer* g_renderer = nullptr;

napi_value Throw(napi_env env, const WasapiError& error) {
  napi_value message = nullptr;
  napi_value code = nullptr;
  napi_value object = nullptr;
  napi_create_string_utf8(env, error.message.c_str(), NAPI_AUTO_LENGTH, &message);
  napi_create_string_utf8(env, error.code.c_str(), NAPI_AUTO_LENGTH, &code);
  napi_create_error(env, code, message, &object);
  napi_throw(env, object);
  return nullptr;
}

napi_value ThrowType(napi_env env, const char* message) {
  napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", message);
  return nullptr;
}

bool ReadString(napi_env env, napi_value value, std::string* out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> buffer(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok) {
    return false;
  }
  out->assign(buffer.data(), length);
  return true;
}

bool ReadUint32(napi_env env, napi_value value, uint32_t* out) {
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok) return false;
  if (number < 0) number = 0;
  *out = static_cast<uint32_t>(number);
  return true;
}

bool ReadBool(napi_env env, napi_value value, bool* out) {
  bool boolean = false;
  if (napi_get_value_bool(env, value, &boolean) != napi_ok) return false;
  *out = boolean;
  return true;
}

napi_value MakeObject(napi_env env) {
  napi_value object = nullptr;
  napi_create_object(env, &object);
  return object;
}

void SetNumber(napi_env env, napi_value object, const char* name, double value) {
  napi_value number = nullptr;
  napi_create_double(env, value, &number);
  napi_set_named_property(env, object, name, number);
}

void SetUint32(napi_env env, napi_value object, const char* name, uint32_t value) {
  napi_value number = nullptr;
  napi_create_uint32(env, value, &number);
  napi_set_named_property(env, object, name, number);
}

void SetBool(napi_env env, napi_value object, const char* name, bool value) {
  napi_value boolean = nullptr;
  napi_get_boolean(env, value, &boolean);
  napi_set_named_property(env, object, name, boolean);
}

void SetString(napi_env env, napi_value object, const char* name, const std::string& value) {
  napi_value string = nullptr;
  napi_create_string_utf8(env, value.c_str(), value.size(), &string);
  napi_set_named_property(env, object, name, string);
}

napi_value FormatToObject(napi_env env, const FormatSpec& format) {
  napi_value object = MakeObject(env);
  SetUint32(env, object, "sampleRate", format.sampleRate);
  SetUint32(env, object, "channels", format.channels);
  SetUint32(env, object, "bits", format.bits);
  SetUint32(env, object, "validBits", format.validBits);
  SetBool(env, object, "isFloat", format.isFloat);
  return object;
}

// listDevices(): { id, name, isDefault }[]
napi_value ListDevices(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_sessionMutex);
  std::vector<DeviceInfo> devices;
  WasapiError error;
  if (!wasapi::EnumerateRenderDevices(&devices, &error)) {
    return Throw(env, error);
  }

  napi_value array = nullptr;
  napi_create_array_with_length(env, devices.size(), &array);
  for (size_t index = 0; index < devices.size(); ++index) {
    napi_value entry = MakeObject(env);
    SetString(env, entry, "id", devices[index].id);
    SetString(env, entry, "name", devices[index].name);
    SetBool(env, entry, "isDefault", devices[index].isDefault);
    napi_set_element(env, array, static_cast<uint32_t>(index), entry);
  }
  return array;
}

// probeFormats(deviceId, channels): supported exclusive formats per sample rate.
napi_value ProbeFormats(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  if (argc < 2) return ThrowType(env, "probeFormats(deviceId, channels) expects two arguments");

  std::string deviceId;
  uint32_t channels = 2;
  if (!ReadString(env, argv[0], &deviceId)) return ThrowType(env, "deviceId must be a string");
  if (!ReadUint32(env, argv[1], &channels)) return ThrowType(env, "channels must be a number");
  if (channels == 0 || channels > 8) return ThrowType(env, "channels must be between 1 and 8");

  std::lock_guard<std::mutex> lock(g_sessionMutex);

  IMMDevice* rawDevice = nullptr;
  WasapiError error;
  if (!wasapi::OpenRenderDevice(deviceId, &rawDevice, &error)) {
    return Throw(env, error);
  }
  wasapi::ComPtr<IMMDevice> device;
  device.Reset(rawDevice);

  wasapi::ComPtr<IAudioClient> client;
  HRESULT hr = device->Activate(
      __uuidof(IAudioClient), CLSCTX_ALL, nullptr,
      reinterpret_cast<void**>(client.Put()));
  if (FAILED(hr)) return Throw(env, wasapi::MakeError(hr, "unable to activate the audio client"));

  static const uint32_t kSampleRates[] = {
      44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000};

  struct CandidateFormat {
    uint16_t bits;
    uint16_t validBits;
    bool isFloat;
  };
  static const CandidateFormat kFormats[] = {
      {16, 16, false},
      {24, 24, false},
      {32, 24, false},
      {32, 32, false},
      {32, 32, true},
  };

  napi_value ratesArray = nullptr;
  napi_create_array(env, &ratesArray);
  uint32_t rateIndex = 0;

  for (const uint32_t rate : kSampleRates) {
    napi_value formatsArray = nullptr;
    napi_create_array(env, &formatsArray);
    uint32_t formatIndex = 0;

    for (const CandidateFormat& candidate : kFormats) {
      FormatSpec spec;
      spec.sampleRate = rate;
      spec.channels = static_cast<uint16_t>(channels);
      spec.bits = candidate.bits;
      spec.validBits = candidate.validBits;
      spec.isFloat = candidate.isFloat;

      std::vector<uint8_t> blob;
      WasapiError buildError;
      if (!wasapi::BuildWaveFormat(spec, &blob, &buildError)) continue;

      if (client->IsFormatSupported(
              AUDCLNT_SHAREMODE_EXCLUSIVE, wasapi::WaveFormatPointer(blob), nullptr) != S_OK) {
        continue;
      }

      napi_value entry = MakeObject(env);
      SetUint32(env, entry, "bits", spec.bits);
      SetUint32(env, entry, "validBits", spec.validBits);
      SetBool(env, entry, "isFloat", spec.isFloat);
      napi_set_element(env, formatsArray, formatIndex++, entry);
    }

    if (formatIndex > 0) {
      napi_value entry = MakeObject(env);
      SetUint32(env, entry, "sampleRate", rate);
      napi_set_named_property(env, entry, "formats", formatsArray);
      napi_set_element(env, ratesArray, rateIndex++, entry);
    }
  }

  napi_value result = MakeObject(env);
  SetString(env, result, "deviceId", deviceId);
  SetUint32(env, result, "channels", channels);
  napi_set_named_property(env, result, "sampleRates", ratesArray);
  return result;
}

// open({ deviceId, sampleRate, channels, formats, bufferMs, ringSeconds })
napi_value Open(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) return ThrowType(env, "open(options) expects an options object");

  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object) {
    return ThrowType(env, "open(options) expects an options object");
  }

  auto readProperty = [env, argv](const char* name) {
    napi_value value = nullptr;
    napi_get_named_property(env, argv[0], name, &value);
    return value;
  };

  OpenRequest request;
  napi_value deviceIdValue = readProperty("deviceId");
  if (!ReadString(env, deviceIdValue, &request.deviceId)) {
    return ThrowType(env, "options.deviceId must be a string");
  }

  napi_value sampleRateValue = readProperty("sampleRate");
  if (!ReadUint32(env, sampleRateValue, &request.sampleRate) || request.sampleRate == 0) {
    return ThrowType(env, "options.sampleRate must be a positive number");
  }

  napi_value channelsValue = readProperty("channels");
  uint32_t channelCount = 0;
  if (!ReadUint32(env, channelsValue, &channelCount) || channelCount == 0 || channelCount > 8) {
    return ThrowType(env, "options.channels must be between 1 and 8");
  }
  request.channels = static_cast<uint16_t>(channelCount);

  napi_value bufferValue = readProperty("bufferMs");
  if (!ReadUint32(env, bufferValue, &request.bufferMs)) request.bufferMs = 100;

  napi_value ringValue = readProperty("ringSeconds");
  if (!ReadUint32(env, ringValue, &request.ringSeconds)) request.ringSeconds = 1;

  napi_value formatsValue = readProperty("formats");
  bool isArray = false;
  napi_is_array(env, formatsValue, &isArray);
  if (isArray) {
    uint32_t length = 0;
    napi_get_array_length(env, formatsValue, &length);
    for (uint32_t index = 0; index < length; ++index) {
      napi_value entry = nullptr;
      napi_get_element(env, formatsValue, index, &entry);
      FormatSpec spec;
      spec.sampleRate = request.sampleRate;
      spec.channels = static_cast<uint16_t>(request.channels);

      napi_value bitsValue = nullptr;
      napi_value validBitsValue = nullptr;
      napi_value floatValue = nullptr;
      napi_get_named_property(env, entry, "bits", &bitsValue);
      napi_get_named_property(env, entry, "validBits", &validBitsValue);
      napi_get_named_property(env, entry, "isFloat", &floatValue);

      uint32_t bits = 16;
      uint32_t validBits = 16;
      bool isFloat = false;
      ReadUint32(env, bitsValue, &bits);
      if (!ReadUint32(env, validBitsValue, &validBits)) validBits = bits;
      ReadBool(env, floatValue, &isFloat);
      if (validBits == 0) validBits = bits;

      spec.bits = static_cast<uint16_t>(bits);
      spec.validBits = static_cast<uint16_t>(validBits);
      spec.isFloat = isFloat;
      request.formats.push_back(spec);
    }
  }

  std::lock_guard<std::mutex> lock(g_sessionMutex);

  if (g_renderer) {
    g_renderer->Close();
    delete g_renderer;
    g_renderer = nullptr;
  }

  OpenResult result;
  WasapiError error;
  ExclusiveRenderer* renderer = ExclusiveRenderer::Open(request, &result, &error);
  if (!renderer) return Throw(env, error);
  g_renderer = renderer;

  napi_value object = MakeObject(env);
  napi_set_named_property(env, object, "format", FormatToObject(env, result.format));
  SetUint32(env, object, "deviceBufferFrames", result.deviceBufferFrames);
  SetUint32(env, object, "ringCapacityFrames", result.ringCapacityFrames);
  SetUint32(env, object, "blockAlign", result.blockAlign);
  SetString(env, object, "deviceName", result.deviceName);
  return object;
}

// write(float32Array): { accepted, buffered }
napi_value Write(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) return ThrowType(env, "write(pcm) expects a Float32Array");

  napi_typedarray_type arrayType = napi_uint8_array;
  size_t length = 0;
  void* data = nullptr;
  napi_value arrayBuffer = nullptr;
  size_t byteOffset = 0;
  if (napi_get_typedarray_info(env, argv[0], &arrayType, &length, &data, &arrayBuffer, &byteOffset) !=
      napi_ok) {
    return ThrowType(env, "write(pcm) expects a Float32Array");
  }

  const float* samples = nullptr;
  size_t sampleCount = 0;
  if (arrayType == napi_float32_array) {
    samples = static_cast<const float*>(data);
    sampleCount = length;
  } else if (arrayType == napi_uint8_array || arrayType == napi_int8_array) {
    // Some IPC paths hand over the raw bytes; accept them as little-endian float32.
    if (length % sizeof(float) != 0) return ThrowType(env, "byte buffer is not float32 aligned");
    samples = reinterpret_cast<const float*>(data);
    sampleCount = length / sizeof(float);
  } else {
    return ThrowType(env, "write(pcm) expects a Float32Array");
  }

  std::lock_guard<std::mutex> lock(g_sessionMutex);
  if (!g_renderer) {
    return Throw(env, WasapiError{"NOT_OPEN", "the exclusive stream is not open"});
  }

  const uint16_t channels = g_renderer->Format().channels;
  if (channels == 0) return Throw(env, WasapiError{"NOT_OPEN", "invalid channel count"});

  const uint32_t frames = static_cast<uint32_t>(sampleCount / channels);
  uint32_t accepted = 0;
  WasapiError error;
  if (!g_renderer->WriteFloat32(samples, frames, &accepted, &error)) {
    return Throw(env, error);
  }

  napi_value object = MakeObject(env);
  SetUint32(env, object, "accepted", accepted);
  SetUint32(env, object, "buffered", g_renderer->BufferedFrames());
  SetBool(env, object, "starved", g_renderer->Starved());
  return object;
}

napi_value Status(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_sessionMutex);
  if (!g_renderer) {
    napi_value object = MakeObject(env);
    SetBool(env, object, "open", false);
    return object;
  }

  const FormatSpec format = g_renderer->Format();
  napi_value object = MakeObject(env);
  SetBool(env, object, "open", true);
  SetBool(env, object, "playing", g_renderer->IsPlaying());
  SetBool(env, object, "starved", g_renderer->Starved());
  SetNumber(env, object, "positionFrames", static_cast<double>(g_renderer->PositionFrames()));
  SetUint32(env, object, "bufferedFrames", g_renderer->BufferedFrames());
  SetUint32(env, object, "ringCapacityFrames", g_renderer->RingCapacityFrames());
  SetUint32(env, object, "deviceBufferFrames", g_renderer->DeviceBufferFrames());
  SetNumber(env, object, "silenceFrames", static_cast<double>(g_renderer->SilenceFrames()));
  napi_set_named_property(env, object, "format", FormatToObject(env, format));

  const ExclusiveRenderer::Diagnostics diagnostics = g_renderer->GetDiagnostics();
  napi_value debug = MakeObject(env);
  SetNumber(env, debug, "events", static_cast<double>(diagnostics.events));
  SetNumber(env, debug, "fills", static_cast<double>(diagnostics.fills));
  SetUint32(env, debug, "padding", diagnostics.padding);
  SetUint32(env, debug, "available", diagnostics.available);
  SetNumber(env, debug, "lastHResult", static_cast<double>(diagnostics.lastHResult));
  SetUint32(env, debug, "errors", diagnostics.errors);
  SetNumber(env, debug, "dataFrames", static_cast<double>(diagnostics.dataFrames));
  SetNumber(env, debug, "clockBase", static_cast<double>(diagnostics.clockBase));
  SetNumber(env, debug, "rawClock", static_cast<double>(diagnostics.rawClock));
  napi_set_named_property(env, object, "debug", debug);
  return object;
}

napi_value Control(napi_env env, napi_callback_info info, const char* action) {
  std::lock_guard<std::mutex> lock(g_sessionMutex);
  if (!g_renderer) {
    return Throw(env, WasapiError{"NOT_OPEN", "the exclusive stream is not open"});
  }

  WasapiError error;
  bool ok = false;
  const std::string name(action);
  if (name == "pause") {
    ok = g_renderer->Pause(&error);
  } else if (name == "resume") {
    ok = g_renderer->Resume(&error);
  } else if (name == "reset") {
    ok = g_renderer->Reset(&error);
  } else {
    return Throw(env, WasapiError{"INVALID_ACTION", "unknown control action"});
  }

  if (!ok) return Throw(env, error);
  napi_value object = MakeObject(env);
  SetBool(env, object, "ok", true);
  return object;
}

napi_value Pause(napi_env env, napi_callback_info info) {
  return Control(env, info, "pause");
}

napi_value Resume(napi_env env, napi_callback_info info) {
  return Control(env, info, "resume");
}

napi_value Reset(napi_env env, napi_callback_info info) {
  return Control(env, info, "reset");
}

napi_value Close(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_sessionMutex);
  if (g_renderer) {
    g_renderer->Close();
    delete g_renderer;
    g_renderer = nullptr;
  }
  napi_value object = MakeObject(env);
  SetBool(env, object, "ok", true);
  return object;
}

napi_value GetVolume(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> lock(g_sessionMutex);
  if (!g_renderer) {
    return Throw(env, WasapiError{"NOT_OPEN", "the exclusive stream is not open"});
  }
  float scalar = 1.0f;
  bool mute = false;
  WasapiError error;
  if (!g_renderer->GetVolume(&scalar, &mute, &error)) return Throw(env, error);

  napi_value object = MakeObject(env);
  SetNumber(env, object, "scalar", scalar);
  SetBool(env, object, "mute", mute);
  return object;
}

napi_value SetVolume(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  double scalar = 1.0;
  bool mute = false;
  if (argc < 1 || napi_get_value_double(env, argv[0], &scalar) != napi_ok) {
    return ThrowType(env, "setVolume(scalar, mute) expects a number");
  }
  if (argc >= 2) ReadBool(env, argv[1], &mute);

  std::lock_guard<std::mutex> lock(g_sessionMutex);
  if (!g_renderer) {
    return Throw(env, WasapiError{"NOT_OPEN", "the exclusive stream is not open"});
  }

  WasapiError error;
  if (!g_renderer->SetVolume(static_cast<float>(scalar), mute, &error)) {
    return Throw(env, error);
  }
  napi_value object = MakeObject(env);
  SetBool(env, object, "ok", true);
  return object;
}

napi_value IsAvailable(napi_env env, napi_callback_info) {
  napi_value value = nullptr;
  napi_get_boolean(env, true, &value);
  return value;
}

void Cleanup(void*) {
  std::lock_guard<std::mutex> lock(g_sessionMutex);
  if (g_renderer) {
    g_renderer->Close();
    delete g_renderer;
    g_renderer = nullptr;
  }
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"listDevices", nullptr, ListDevices, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"probeFormats", nullptr, ProbeFormats, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"open", nullptr, Open, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"write", nullptr, Write, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"pause", nullptr, Pause, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"resume", nullptr, Resume, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"reset", nullptr, Reset, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getVolume", nullptr, GetVolume, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setVolume", nullptr, SetVolume, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"isAvailable", nullptr, IsAvailable, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
