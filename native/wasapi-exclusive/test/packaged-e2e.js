#!/usr/bin/env node
// End-to-end check inside the packaged Windows build:
//   * the preload bridge exposes the WASAPI API,
//   * device enumeration reaches the native addon shipped in resources/native,
//   * the settings page renders the exclusive section and selecting a device
//     activates the exclusive backend (store -> playerCore -> engine).
//
//   node native/wasapi-exclusive/test/packaged-e2e.js
//
// Requires `npm run build` and `npx electron-builder --win --dir`.
'use strict'

const { spawn } = require('child_process')
const http = require('http')
const path = require('path')
const WebSocket = require('ws')

const root = path.join(__dirname, '..', '..', '..')
const appBinary = path.join(root, 'release', 'win-unpacked', 'Sollin.exe')
const PORT = 9555
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.setTimeout(1500, () => request.destroy(new Error('timeout')))
  })
}

async function waitForAppTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`)
      const page = targets.find((target) => target.type === 'page'
        && target.webSocketDebuggerUrl
        && (target.url.includes('index.html') || target.url.startsWith('file:')))
      if (page) return page
    } catch (error) {
      lastError = error
    }
    await sleep(300)
  }
  throw new Error(`app window not found: ${lastError && lastError.message}`)
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.id && pending.has(message.id)) {
      const { resolve } = pending.get(message.id)
      pending.delete(message.id)
      resolve(message)
    }
  })
  const ready = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const send = (method, params) => new Promise((resolve) => {
    const id = nextId++
    pending.set(id, { resolve })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { ready, send, close: () => socket.close() }
}

async function evaluate(client, expression) {
  const message = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000,
  })
  const result = message.result
  if (!result) throw new Error(`empty CDP result: ${JSON.stringify(message).slice(0, 400)}`)
  if (result.exceptionDetails) {
    throw new Error(`evaluation failed: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`)
  }
  return result.result ? result.result.value : undefined
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok })
  console.log(`[packaged] ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`)
}

async function main() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(appBinary, [`--remote-debugging-port=${PORT}`], { cwd: path.dirname(appBinary), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })

  let client = null
  try {
    const target = await waitForAppTarget(90000)
    console.log('[packaged] window:', target.url)
    client = connect(target.webSocketDebuggerUrl)
    await client.ready
    await client.send('Runtime.enable')

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ready = await evaluate(client, 'Boolean(window.electronAPI && window.electronAPI.wasapiListDevices)')
      if (ready) break
      await sleep(250)
    }
    check('preload bridge present', await evaluate(client, 'typeof window.electronAPI.wasapiListDevices === "function"'))

    const devices = await evaluate(client, 'window.electronAPI.wasapiListDevices()')
    check('native addon loadable from resources/native', Boolean(devices && devices.ok && devices.value.supported), devices && (devices.message || devices.value))
    const list = (devices && devices.ok && devices.value.devices) || []
    check('render endpoints enumerated', list.length > 0, list.map((entry) => entry.name))

    // Settings is a modal, opened from the top bar gear button.  Wait for the
    // React tree to finish mounting before looking for it.
    let modalOpened = false
    for (let attempt = 0; attempt < 40 && !modalOpened; attempt += 1) {
      modalOpened = await evaluate(client, `(() => {
        const byTitle = document.querySelector('button[title="设置"]')
        const byIcon = Array.from(document.querySelectorAll('button'))
          .find((button) => button.querySelector('svg.lucide-settings'))
        const button = byTitle || byIcon
        if (!button) return false
        button.click()
        return true
      })()`)
      if (!modalOpened) await sleep(250)
    }
    check('settings modal can be opened', modalOpened)
    if (!modalOpened) {
      const titles = await evaluate(client, `Array.from(document.querySelectorAll('button'))
        .map((button) => button.getAttribute('title') || button.getAttribute('aria-label') || '')
        .filter(Boolean).slice(0, 40)`)
      console.log('[packaged] button titles:', JSON.stringify(titles))
    }

    let navClicked = false
    for (let attempt = 0; attempt < 40 && !navClicked; attempt += 1) {
      await sleep(250)
      navClicked = await evaluate(client, `(() => {
        const buttons = Array.from(document.querySelectorAll('button'))
        const target = buttons.find((button) => (button.textContent || '').trim() === '音频设备')
        if (!target) return false
        target.click()
        return true
      })()`)
    }
    check('audio-device settings section reachable', navClicked)
    await sleep(1200)

    const sectionText = await evaluate(client, `(() => {
      const section = document.querySelector('#section-device')
      return section ? section.innerText : ''
    })()`)
    check('settings shows WASAPI exclusive block', sectionText.includes('WASAPI 独占'), sectionText.slice(0, 200))
    check('settings lists the native endpoint', list.length > 0 && sectionText.includes(list[0].name), list[0] && list[0].name)

    // Select the exclusive device through the real UI button.
    const clicked = await evaluate(client, `(() => {
      const rows = Array.from(document.querySelectorAll('#section-device button'))
      const names = ${JSON.stringify(list.map((entry) => entry.name))}
      const target = rows.find((button) => {
        const text = button.textContent || ''
        return text.includes('独占模式') && names.some((name) => text.includes(name))
      })
      if (!target) return false
      target.click()
      return true
    })()`)
    check('exclusive device row is clickable', clicked)
    await sleep(2500)

    const afterClick = await evaluate(client, `(() => {
      const section = document.querySelector('#section-device')
      const text = section ? section.innerText : document.body.innerText
      return {
        activated: text.includes('已启用独占输出') || text.includes('bit-perfect'),
        hasExclusivePanel: text.includes('WASAPI 独占'),
      }
    })()`)
    check('selecting the device activates exclusive output', Boolean(afterClick && afterClick.activated), afterClick)

    // Open/write/resume through the engine-independent bridge once more to prove
    // the packaged binary can really drive the endpoint.
    const played = await evaluate(client, `(async () => {
      const list = (await window.electronAPI.wasapiListDevices()).value.devices
      const device = list.find((entry) => entry.isDefault) || list[0]
      // Release any stream the UI just opened.
      await window.electronAPI.wasapiClose()
      const opened = await window.electronAPI.wasapiOpen({
        deviceId: device.id,
        sampleRate: 48000,
        channels: 2,
        formats: [{ bits: 32, validBits: 24, isFloat: false }, { bits: 16, validBits: 16, isFloat: false }],
        bufferMs: 100,
      })
      if (!opened.ok) return { error: opened.message, code: opened.code }
      const frames = opened.value.deviceBufferFrames || 4800
      const pcm = new Float32Array(frames * 2)
      for (let i = 0; i < frames; i += 1) {
        const value = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.1
        pcm[i * 2] = value
        pcm[i * 2 + 1] = value
      }
      await window.electronAPI.wasapiWrite(pcm)
      await window.electronAPI.wasapiControl('resume')
      await new Promise((resolve) => setTimeout(resolve, 500))
      const status = await window.electronAPI.wasapiStatus()
      await window.electronAPI.wasapiClose()
      return { format: opened.value.format, positionFrames: status.ok ? status.value.positionFrames : null }
    })()`)
    check('packaged addon plays through the endpoint', Boolean(played && !played.error && played.positionFrames > 0), played)
  } finally {
    try {
      if (client) await evaluate(client, 'window.electronAPI && window.electronAPI.quit && window.electronAPI.quit()')
    } catch {
      // Already gone.
    }
    client?.close()
    await sleep(1200)
    if (child.exitCode === null) child.kill()
    const interesting = output.split('\n').filter((line) => /wasapi|preload|Error/i.test(line)).slice(0, 12)
    if (interesting.length > 0) console.log('[packaged] app output:\n' + interesting.join('\n'))
  }

  const failed = checks.filter((entry) => !entry.ok)
  console.log(failed.length === 0 ? '[packaged] OK' : `[packaged] ${failed.length} failure(s)`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[packaged] failed:', error)
  process.exit(1)
})
