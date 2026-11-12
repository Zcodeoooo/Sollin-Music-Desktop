#!/usr/bin/env node
// Reproduces and verifies the root cause of "exclusive playback stops when the
// window is minimised": Chromium throttles timers of hidden pages, and the
// WASAPI engine feeds the device from a renderer timer.
//
// Measures setInterval ticks while visible, while minimised with the default
// throttling, and while minimised after webContents.setBackgroundThrottling(false).
//
//   ELECTRON_RUN_AS_NODE= node_modules\.bin\electron native/wasapi-exclusive/test/background-throttling.js
'use strict'

const { app, BrowserWindow } = require('electron')

const PAGE = `<!doctype html><html><body><script>
  window.__tickCount = 0
  window.__startedAt = performance.now()
  setInterval(() => {
    window.__tickCount += 1
  }, 20)
</script></body></html>`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function ticks(win, durationMs) {
  const before = await win.webContents.executeJavaScript('window.__tickCount')
  const startedAt = Date.now()
  await sleep(durationMs)
  const after = await win.webContents.executeJavaScript('window.__tickCount')
  return { ticks: after - before, elapsedMs: Date.now() - startedAt }
}

async function main() {
  app.disableHardwareAcceleration()
  await app.whenReady()

  const win = new BrowserWindow({
    width: 480,
    height: 320,
    show: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: true },
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
  await sleep(800)

  const visible = await ticks(win, 1500)
  console.log('[throttle] visible:', JSON.stringify(visible))

  win.minimize()
  await sleep(1200)

  const throttled = await ticks(win, 3000)
  console.log('[throttle] minimised, throttling ON:', JSON.stringify(throttled))

  win.webContents.setBackgroundThrottling(false)
  await sleep(400)
  const unthrottled = await ticks(win, 3000)
  console.log('[throttle] minimised, throttling OFF:', JSON.stringify(unthrottled))

  win.webContents.setBackgroundThrottling(true)
  win.restore()

  // A visible page at 20 ms should tick ~50/s, but a window that is merely
  // covered by another window can already be treated as hidden, so the
  // unthrottled baseline is informational.  The meaningful comparison is the
  // minimised window with and without the throttling opt-out.
  const failures = []
  if (throttled.ticks > 30) {
    failures.push(`minimised window was not throttled (${throttled.ticks} ticks in 3s)`)
  }
  if (unthrottled.ticks < 60) {
    failures.push(`setBackgroundThrottling(false) did not restore the timer (${unthrottled.ticks} ticks in 3s)`)
  }
  if (unthrottled.ticks < throttled.ticks * 3) {
    failures.push(`throttling toggle had no clear effect (${throttled.ticks} -> ${unthrottled.ticks})`)
  }

  win.destroy()
  if (failures.length > 0) {
    for (const failure of failures) console.error('[throttle] FAIL:', failure)
    app.exit(1)
    return
  }
  console.log('[throttle] OK')
  app.exit(0)
}

main().catch((error) => {
  console.error('[throttle] failed:', error)
  app.exit(1)
})
