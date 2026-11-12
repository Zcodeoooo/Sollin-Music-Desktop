#!/usr/bin/env node
// Unit test for the PCM normalization detector used by the bit-perfect path.
//
// Compiles src/services/pcmNormalization.ts to a temp directory and checks that
// the detected scales reproduce the original integer samples exactly for the
// three real-world cases:
//   * 16 bit integer PCM with Chromium's asymmetric normalization,
//   * 24 bit integer PCM with symmetric normalization,
//   * lossy float PCM (no detection, no compensation).
'use strict'

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(__dirname, '..', '..', '..')
const sourceFile = path.join(root, 'src', 'services', 'pcmNormalization.ts')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sollin-pcmnorm-'))

execFileSync(
  process.execPath,
  [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    sourceFile,
    '--outDir', outDir,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--skipLibCheck',
  ],
  { stdio: 'inherit' },
)

// eslint-disable-next-line import/no-dynamic-require
const { detectPcmNormalization } = require(path.join(outDir, 'pcmNormalization.js'))

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`[pcmnorm] ok   ${name}`)
  } else {
    failures += 1
    console.error(`[pcmnorm] FAIL ${name}${detail ? `: ${detail}` : ''}`)
  }
}

function buildPlanes(samples, bits, mode) {
  const half = Math.pow(2, bits - 1)
  const positiveScale = mode === 'asymmetric' ? half - 1 : half
  const plane = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]
    plane[index] = value >= 0 ? value / positiveScale : value / half
  }
  return [plane]
}

function verifyExact(samples, bits, normalization) {
  const half = Math.pow(2, bits - 1)
  const positiveGain = normalization.positiveGain
  const negativeGain = normalization.negativeGain
  let mismatches = 0
  let maxError = 0
  for (const original of samples) {
    const scale = original >= 0 ? (bits === 16 ? (half - 1) : half) : half
    const decoded = original / scale
    const restored = original >= 0 ? decoded * positiveGain : decoded * negativeGain
    const recovered = Math.round(restored * half)
    if (recovered !== original) {
      mismatches += 1
      maxError = Math.max(maxError, Math.abs(recovered - original))
    }
  }
  return { mismatches, maxError }
}

// ---- 16 bit, asymmetric (Chromium behaviour measured on Electron 43) --------
const samples16 = new Int32Array(65536)
for (let i = 0; i < 65536; i += 1) {
  samples16[i] = i - 32768
}
const norm16 = detectPcmNormalization(buildPlanes(samples16, 16, 'asymmetric'), 16)
check('16 bit detection returns a result', Boolean(norm16), JSON.stringify(norm16))
if (norm16) {
  check('16 bit positive scale', norm16.positiveScale === 32767, String(norm16.positiveScale))
  check('16 bit negative scale', norm16.negativeScale === 32768, String(norm16.negativeScale))
  check('16 bit gain', Math.abs(norm16.positiveGain - 32767 / 32768) < 1e-12, String(norm16.positiveGain))
  const result = verifyExact(samples16, 16, norm16)
  check('16 bit exact reconstruction', result.mismatches === 0, JSON.stringify(result))
}

// ---- 24 bit, symmetric ------------------------------------------------------
const samples24 = new Int32Array(40000)
const half24 = 8388608
for (let i = 0; i < 40000; i += 1) {
  const raw = Math.round((i * 2654435761) % (half24 * 2))
  samples24[i] = Math.max(-half24, Math.min(half24 - 1, raw - half24))
}
const norm24 = detectPcmNormalization(buildPlanes(samples24, 24, 'symmetric'), 24)
check('24 bit detection returns a result', Boolean(norm24), JSON.stringify(norm24))
if (norm24) {
  check('24 bit symmetric scales', norm24.positiveScale === half24 && norm24.negativeScale === half24)
  check('24 bit needs no gain', norm24.positiveGain === 1 && norm24.negativeGain === 1)
  const result = verifyExact(samples24, 24, norm24)
  check('24 bit exact reconstruction', result.mismatches === 0, JSON.stringify(result))
}

// ---- lossy float content (no integer grid) ----------------------------------
const lossy = [new Float32Array(4096)]
for (let i = 0; i < 4096; i += 1) {
  lossy[0][i] = Math.sin(i * 0.01) * 0.7 + Math.sin(i * 0.0031) * 0.2
}
check('lossy content is not treated as integer PCM', detectPcmNormalization(lossy, 16) === null)

// ---- single polarity ---------------------------------------------------------
const positivesOnly = buildPlanes([100, 2000, 30000, 32767], 16, 'asymmetric')
const normPos = detectPcmNormalization(positivesOnly, 16)
check('single polarity keeps symmetric negative scale', Boolean(normPos) && normPos.negativeScale === 32768)

// ---- 24 bit integer data analyzed as 16 bit must not falsely pass -----------
const wrongDepth = detectPcmNormalization(buildPlanes(samples24, 24, 'symmetric'), 16)
check('wrong bit depth is rejected', wrongDepth === null, JSON.stringify(wrongDepth))

fs.rmSync(outDir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`[pcmnorm] ${failures} failure(s)`)
  process.exit(1)
}
console.log('[pcmnorm] OK')
