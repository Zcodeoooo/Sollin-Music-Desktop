#!/usr/bin/env node
// Builds the optional WASAPI exclusive native addon.
//
//   npm run wasapi:build          -> builds against the Electron headers
//   node scripts/build-wasapi.js --node   -> builds against the local Node headers
//
// The addon only exists on Windows; every other platform skips the build and the
// application keeps using the regular Chromium audio output.
'use strict'

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const addonDir = path.join(root, 'native', 'wasapi-exclusive')
const pkg = require(path.join(root, 'package.json'))

if (process.platform !== 'win32') {
  console.log('[wasapi] skipped: the exclusive output addon is Windows only')
  process.exit(0)
}

const localNodeGyp = path.join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
if (!fs.existsSync(localNodeGyp)) {
  console.error('[wasapi] node-gyp is missing. Run "npm install" first.')
  process.exit(1)
}

const buildForNode = process.argv.includes('--node')
const electronVersion = String(
  (pkg.devDependencies && pkg.devDependencies.electron) ||
  (pkg.dependencies && pkg.dependencies.electron) ||
  '',
).replace(/^[^0-9]*/, '')

const args = ['rebuild', '--directory', addonDir, '--arch', process.arch]
const env = { ...process.env }

if (!buildForNode && electronVersion) {
  // node-gyp only reads the target/dist-url configuration from npm_config_*
  // environment variables when invoked directly.
  env.npm_config_target = electronVersion
  env.npm_config_disturl = 'https://electronjs.org/headers'
  env.npm_config_runtime = 'electron'
  env.npm_config_arch = process.arch
  console.log(`[wasapi] building against Electron ${electronVersion} headers`)
} else {
  delete env.npm_config_target
  delete env.npm_config_disturl
  delete env.npm_config_runtime
  console.log(`[wasapi] building against the local Node ${process.version} headers`)
}

const result = spawnSync(process.execPath, [localNodeGyp, ...args], {
  cwd: root,
  stdio: 'inherit',
  env,
})

if (result.error) {
  console.error('[wasapi] failed to start node-gyp:', result.error.message)
  process.exit(1)
}
if (result.status !== 0) {
  console.error('[wasapi] build failed with exit code', result.status)
  process.exit(result.status || 1)
}

const outputPath = path.join(addonDir, 'build', 'Release', 'wasapi_exclusive.node')
if (!fs.existsSync(outputPath)) {
  console.error('[wasapi] build finished but', outputPath, 'is missing')
  process.exit(1)
}
console.log('[wasapi] built', path.relative(root, outputPath))
