// Loader for the compiled WASAPI exclusive addon.
//
// Resolution order:
//   1. SOLLIN_WASAPI_ADDON environment variable (development / debugging)
//   2. <resources>/native/wasapi_exclusive.node  (packaged application)
//   3. native/wasapi-exclusive/build/Release/wasapi_exclusive.node
//   4. native/wasapi-exclusive/build/Debug/wasapi_exclusive.node
//
// The module is optional: on other platforms, or when the binary was never
// built, callers receive { addon: null, error } and can fall back to the normal
// Chromium audio pipeline.
'use strict'

const fs = require('fs')
const path = require('path')

function candidatePaths() {
  const candidates = []
  if (process.env.SOLLIN_WASAPI_ADDON) {
    candidates.push(process.env.SOLLIN_WASAPI_ADDON)
  }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'native', 'wasapi_exclusive.node'))
  }
  candidates.push(path.join(__dirname, 'build', 'Release', 'wasapi_exclusive.node'))
  candidates.push(path.join(__dirname, 'build', 'Debug', 'wasapi_exclusive.node'))
  return candidates
}

function loadAddon() {
  if (process.platform !== 'win32') {
    return { addon: null, error: 'WASAPI exclusive output is only available on Windows' }
  }

  const failures = []
  for (const candidate of candidatePaths()) {
    if (!fs.existsSync(candidate)) continue
    try {
      return { addon: require(candidate), error: null, path: candidate }
    } catch (error) {
      failures.push(`${candidate}: ${error && error.message ? error.message : error}`)
    }
  }

  if (failures.length > 0) {
    return { addon: null, error: failures.join('; ') }
  }

  return {
    addon: null,
    error: 'wasapi_exclusive.node was not found; run "npm run wasapi:build" first',
  }
}

const loaded = loadAddon()

module.exports = loaded
module.exports.candidatePaths = candidatePaths
