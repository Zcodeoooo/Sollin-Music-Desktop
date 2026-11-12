#include "device_enumerator.h"

#include <algorithm>

namespace wasapi {
namespace {

bool CreateEnumerator(ComPtr<IMMDeviceEnumerator>* enumerator, WasapiError* error) {
  EnsureComInitialized();
  HRESULT hr = ::CoCreateInstance(
      kClsidMMDeviceEnumerator,
      nullptr,
      CLSCTX_ALL,
      __uuidof(IMMDeviceEnumerator),
      reinterpret_cast<void**>(enumerator->Put()));
  if (FAILED(hr)) {
    *error = MakeError(hr, "failed to create the audio device enumerator");
    return false;
  }
  return true;
}

}  // namespace

std::string ReadFriendlyName(IMMDevice* device) {
  if (!device) return std::string();

  ComPtr<IPropertyStore> properties;
  HRESULT hr = device->OpenPropertyStore(STGM_READ, properties.Put());
  if (FAILED(hr)) return std::string();

  PROPVARIANT value;
  ::PropVariantInit(&value);
  std::string name;
  if (SUCCEEDED(properties->GetValue(kPkeyDeviceFriendlyName, &value)) && value.vt == VT_LPWSTR) {
    name = WideToUtf8(value.pwszVal);
  }
  ::PropVariantClear(&value);
  return name;
}

bool EnumerateRenderDevices(std::vector<DeviceInfo>* devices, WasapiError* error) {
  if (!devices) return false;
  devices->clear();

  ComPtr<IMMDeviceEnumerator> enumerator;
  if (!CreateEnumerator(&enumerator, error)) return false;

  ComPtr<IMMDeviceCollection> collection;
  HRESULT hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, collection.Put());
  if (FAILED(hr)) {
    *error = MakeError(hr, "failed to enumerate audio render endpoints");
    return false;
  }

  std::string defaultId;
  {
    ComPtr<IMMDevice> defaultDevice;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, defaultDevice.Put())) && defaultDevice) {
      LPWSTR id = nullptr;
      if (SUCCEEDED(defaultDevice->GetId(&id)) && id) {
        defaultId = WideToUtf8(id);
        ::CoTaskMemFree(id);
      }
    }
  }

  UINT count = 0;
  hr = collection->GetCount(&count);
  if (FAILED(hr)) {
    *error = MakeError(hr, "failed to read the audio render endpoint count");
    return false;
  }

  for (UINT index = 0; index < count; ++index) {
    ComPtr<IMMDevice> device;
    if (FAILED(collection->Item(index, device.Put())) || !device) continue;

    LPWSTR rawId = nullptr;
    if (FAILED(device->GetId(&rawId)) || !rawId) continue;

    DeviceInfo info;
    info.id = WideToUtf8(rawId);
    ::CoTaskMemFree(rawId);

    info.name = ReadFriendlyName(device.Get());
    if (info.name.empty()) {
      info.name = "Audio device " + std::to_string(index + 1);
    }
    info.isDefault = !defaultId.empty() && info.id == defaultId;
    info.isCurrentDefault = info.isDefault;
    devices->push_back(std::move(info));
  }

  // Default endpoint first so the UI highlights it without extra sorting work.
  std::stable_sort(devices->begin(), devices->end(), [](const DeviceInfo& a, const DeviceInfo& b) {
    return a.isDefault && !b.isDefault;
  });

  return true;
}

bool OpenRenderDevice(const std::string& deviceId, IMMDevice** device, WasapiError* error) {
  if (!device) return false;
  *device = nullptr;

  ComPtr<IMMDeviceEnumerator> enumerator;
  if (!CreateEnumerator(&enumerator, error)) return false;

  std::wstring wideId = Utf8ToWide(deviceId);
  HRESULT hr = enumerator->GetDevice(wideId.c_str(), device);
  if (FAILED(hr) || !*device) {
    *error = MakeError(FAILED(hr) ? hr : E_POINTER, "unable to open the selected audio endpoint");
    return false;
  }
  return true;
}

}  // namespace wasapi
