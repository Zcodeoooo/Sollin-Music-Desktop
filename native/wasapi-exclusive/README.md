# wasapi-exclusive

N-API 原生模块，为 Sollin 提供 Windows **WASAPI 独占模式（bit-perfect）** 音频输出。

模块只依赖 Windows SDK（`audioclient` / `mmdeviceapi` / `endpointvolume` / `avrt`），
不需要额外第三方库；对外暴露 `napi` 接口，ABI 稳定，可同时被 Node 与 Electron 加载。

## 为什么需要它

Chromium 的音频输出始终经过 Windows 混音器（Audio Engine + APO），采样率跟随系统
“共享模式”格式，音量、音效、重采样都会修改送往声卡的 PCM。独占模式让应用直接以文件
原始的采样率 / 位深打开端点，独占硬件缓冲，从而做到位级直通。

## 结构

```
native/wasapi-exclusive/
├── binding.gyp                  node-gyp 构建描述
├── index.js                     Node 加载器（解析 .node 路径）
├── src/
│   ├── addon.cc                 N-API 绑定（参数校验 / 错误映射）
│   ├── wasapi_common.h          COM 工具、WAVEFORMATEXTENSIBLE 构造、错误码
│   ├── device_enumerator.h/.cc  渲染端点枚举与友好名称
│   └── exclusive_renderer.h/.cc IAudioClient 独占流、环形缓冲、渲染线程、时钟、音量
└── test/                        冒烟与专项测试（见下）
```

## 线程模型

- **调用线程（Electron 主进程 / Node）**：只做端点枚举、格式探测、把 float32 PCM 转换后
  写入环形缓冲。全部调用都是非阻塞的。
- **渲染线程**：MTA 初始化 COM，`CoCreateInstance` 枚举器、打开设备、`IAudioClient::Initialize`
  （独占 + 事件回调）、`SetEventHandle`，然后循环等待事件 → `GetBuffer` / `ReleaseBuffer`。
  停止、重置、硬件音量、时钟读取等也通过命令队列在该线程执行，避免 COM 接口跨套间调用。
- **时间基准**：`IAudioClock::GetPosition` 换算成帧数，重置后归零，供渲染进程计算进度。

## API

```ts
listDevices(): Array<{ id: string; name: string; isDefault: boolean }>

probeFormats(deviceId: string, channels: number): {
  deviceId: string
  channels: number
  sampleRates: Array<{
    sampleRate: number
    formats: Array<{ bits: number; validBits: number; isFloat: boolean }>
  }>
}

open(options: {
  deviceId: string
  sampleRate: number
  channels: number
  formats: Array<{ bits: number; validBits: number; isFloat: boolean }>  // 优先级从高到低
  bufferMs?: number      // 默认 100
  ringSeconds?: number   // 默认 1
}): {
  format: { sampleRate: number; channels: number; bits: number; validBits: number; isFloat: boolean }
  deviceBufferFrames: number
  ringCapacityFrames: number
  blockAlign: number
  deviceName: string
}

write(pcm: Float32Array): { accepted: number; buffered: number }
status(): { open: boolean; playing: boolean; positionFrames: number; bufferedFrames: number; ...; debug?: {...} }
pause(): { ok: boolean }
resume(): { ok: boolean }
reset(): { ok: boolean }        // 停止 → 清空缓冲 → 时钟归零（驱动不支持 Reset 时重建流）
close(): { ok: boolean }
getVolume(): { scalar: number; mute: boolean }
setVolume(scalar: number, mute: boolean): { ok: boolean }
```

错误通过 `Error` 抛出，并额外带 `code` 字段（如 `DEVICE_IN_USE`、`UNSUPPORTED_FORMAT`、
`EXCLUSIVE_MODE_NOT_ALLOWED`），渲染进程据此给出中文提示或触发回退。

## 关键实现细节

### 独占模式必须整块提交

`IAudioClient::GetCurrentPadding` 在独占模式下即使引擎在等待第一块数据也返回“缓冲已满”，
因此共享模式那套 `bufferSize - padding` 的算法不可用。事件回调的语义是“可以提交下一整块”，
所以每次事件都写入**恰好一个 `deviceBufferFrames`**，不足部分补静音；释放半块会重放旧样本。

### 生产者断流时停车（park）

渲染进程用定时器把 PCM 喂进环形缓冲。窗口最小化、被遮挡或渲染进程卡顿时，Chromium 会降频
定时器：缓冲被播完，设备只能空转。

- 第一次发现环形缓冲为空时，先补**一个**静音块，让已经提交到设备队列的最后一个音频块正常播完
  （否则立刻 Stop 会丢掉最多一个设备缓冲的音频）。
- 连续第二次为空时 `IAudioClient::Stop()`，把 `IAudioClock` 冻结在真实内容位置，并把上报位置
  钳到“已提交的内容帧”。这样进度/歌词不会因为静音而跑到音频前面，恢复后也不会跳。
- 渲染端写入新数据并 `resume()` 后继续播放，位置从冻结处接续；实测停车 9624 → 恢复 9638 →
  下一轮停车 19230（两次共写入 19200 帧，无丢帧）。

`status()` 里的 `starved` 表示当前处于停车状态，`silenceFrames` 表示补过的静音帧数（诊断用）。

### 后台节流

仅靠停车只能“断流不跑偏”，要真正连续播放还需要让喂数据的定时器在窗口不可见时继续运行：
渲染端在独占播放开始时通过 `wasapi:background-throttling` 关闭该窗口的 `backgroundThrottling`
（暂停/结束/释放时恢复）。实测（`test/background-throttling.js`）：最小化窗口 3 秒内定时器
回调数 **3 次（未处理）→ 150 次（关闭节流）**。

### 缓冲区时长与时基

`Initialize` 会依次尝试 `(duration, duration)`、`(duration, 0)`、`(0, 0)` 三种周期组合，并处理
`AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED`（用 `GetBufferSize` 对齐后重建 client）。不同声卡驱动
对独占模式周期比较敏感，这套回退保证常见设备都能打开。

### 位深与容器

`WAVEFORMATEXTENSIBLE` 支持 16 / 24（紧凑 3 字节）/ 24-in-32（有效位左对齐）/ 32 bit int /
32 bit float。渲染端按“源位深优先”的顺序给出候选格式，模块返回实际协商成功的那个。

float32 → 整数转换使用 2 的幂缩放并饱和，因此 16 / 24 bit 整数源可以精确往返。

### 硬件音量

`IAudioEndpointVolume` 在独占模式下通常由声卡硬件实现，调整它不会修改 PCM 数据，因此不破坏
bit-perfect。少数驱动不暴露该接口，此时 `getVolume` 返回 `VOLUME_UNSUPPORTED`，渲染进程保留
软件音量设置但不作用于样本。

## 构建

需要 Visual Studio 2019/2022（C++ 桌面工作负载）与 Python 3。

```bash
npm run wasapi:build        # 以 Electron 头文件编译（默认，用于打包）
npm run wasapi:build:node   # 以本机 Node 头文件编译（用于直接 node 测试）
```

产物：`native/wasapi-exclusive/build/Release/wasapi_exclusive.node`。

加载顺序（`index.js` 与 `electron/wasapiOutput.ts` 保持一致）：

1. `SOLLIN_WASAPI_ADDON` 环境变量
2. `<resources>/native/wasapi_exclusive.node`（打包后）
3. `native/wasapi-exclusive/build/Release/wasapi_exclusive.node`（开发）
4. `native/wasapi-exclusive/build/Debug/wasapi_exclusive.node`

任一环节失败都不会影响应用启动：加载器返回 `{ addon: null, error }`，UI 显示不支持并回退。

## 测试

| 脚本 | 需要 | 验证内容 |
| --- | --- | --- |
| `test/smoke.js` | Node + 声卡 | 枚举、探测、独占打开、实时时钟推进、暂停/恢复、重置、硬件音量 |
| `test/starvation.js` | Node + 声卡 | 生产者断流时停车、时钟冻结在内容位置、恢复后不丢帧不跳变 |
| `test/electron-load.js` | Electron | 模块能被 Electron 主进程加载（ABI / N-API 兼容） |
| `test/preload-bridge.js` | Electron | 真实 preload → contextBridge → IPC → 原生模块 → 声卡全链路 |
| `test/background-throttling.js` | Electron | 最小化窗口的定时器节流，以及 `setBackgroundThrottling(false)` 的修复效果 |
| `test/minimized-playback.js` | Electron + 声卡 | 真实 preload/IPC + 定时器喂数据，最小化窗口 4 秒后播放时钟仍按实时推进 |
| `test/packaged-e2e.js` | 已打包应用 | 打包后的 `Sollin.exe` 中：模块从 `resources/native` 加载、设置页渲染、选择设备激活独占、端点播放 |
| `test/renderer-decode.js` | Electron | `decodeAudioData` 是否按上下文采样率解码 / 重采样 |
| `test/decode-mapping.js` | Electron | 穷举验证 Chromium 对 16/24 bit 整数 PCM 的归一化规则 |
| `test/pcm-normalization.js` | Node | 渲染端归一化检测与逐位还原算法 |
| `test/audio-format-probe.js` | Node | WAV / FLAC / MP3 / OGG / Opus / M4A / AAC 头解析 |

`decode-mapping.js` 证实：Chromium 43 对 16 bit 整数 PCM 采用**非对称归一化**
（`v >= 0` 除以 32767，`v < 0` 除以 32768），24 bit 则是对称的 2^23。渲染端因此按曲目
探测并补偿，否则约一半样本会差 1 LSB——这正是“能出声”和“bit-perfect”的区别。

Electron 测试需要清空 `ELECTRON_RUN_AS_NODE`：

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
node_modules\.bin\electron native\wasapi-exclusive\test\preload-bridge.js
```

## 已知限制

- 仅 Windows；其它平台脚本会跳过构建。
- 独占模式会占用设备，播放期间其它程序无法通过该设备发声。
- 窗口不可见时为了让喂数据的定时器继续运行，会在独占播放期间关闭该窗口的后台节流（暂停/结束即恢复），
  因此隐藏窗口时 CPU 占用与非隐藏状态接近；这是连续播放的前提。
- 整轨需要在渲染进程解码（Chromium 的 `decodeAudioData` 一次只能处理完整文件），因此会先把整首歌读入内存；
  解码后超过 512 MB 的超长音频会自动回退到流式的常规输出。
- 首次播放需要等待整轨下载 + 解码完成（本地文件通常 < 300 ms，网络音源取决于带宽），之后 seek 是内存内操作。
- 若声卡驱动不支持文件采样率（例如只支持 48k 的设备播放 44.1k 文件），会重采样并在 UI 标注。
- `IAudioClient::Reset` 在少数独占驱动上不可用，此时 seek 通过重建流实现（约几十毫秒）。
- DSD / APE / WMA 等 Chromium 无法解码的格式无法走这条链路，会回退到常规播放。
- 独占模式下音频可视化、EQ、混响、空间音频、响度均衡与变速播放不生效（这是 bit-perfect 的前提）。
