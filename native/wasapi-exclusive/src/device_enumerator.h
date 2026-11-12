// Render endpoint enumeration for the WASAPI exclusive addon.
#pragma once

#include <string>
#include <vector>

#include "wasapi_common.h"

namespace wasapi {

struct DeviceInfo {
  std::string id;
  std::string name;
  bool isDefault = false;
  bool isCurrentDefault = false;
};

// Returns every active render endpoint.  The order matches the Windows device
// order so the UI can present a stable list.
bool EnumerateRenderDevices(std::vector<DeviceInfo>* devices, WasapiError* error);

// Looks up one render endpoint by its endpoint id.  The caller owns the pointer.
bool OpenRenderDevice(const std::string& deviceId, IMMDevice** device, WasapiError* error);

// Reads the friendly name of an endpoint; falls back to the endpoint id.
std::string ReadFriendlyName(IMMDevice* device);

}  // namespace wasapi
