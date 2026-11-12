{
  "targets": [
    {
      "target_name": "wasapi_exclusive",
      "sources": [
        "src/addon.cc",
        "src/device_enumerator.cc",
        "src/exclusive_renderer.cc"
      ],
      "include_dirs": [
        "src"
      ],
      "defines": [
        "UNICODE",
        "_UNICODE",
        "NAPI_VERSION=8"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "ole32.lib",
              "uuid.lib",
              "avrt.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": [
                  "/std:c++17",
                  "/permissive-",
                  "/utf-8"
                ],
                "ExceptionHandling": 1,
                "WarningLevel": 3
              }
            }
          }
        ]
      ]
    }
  ]
}
