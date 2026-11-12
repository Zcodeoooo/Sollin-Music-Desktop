// Detects and compensates the integer normalization Chromium's decoder applies
// when it converts PCM to float.
//
// Measured behaviour (Electron 43 / Chromium, verified exhaustively for 16 bit
// and sampled for 24 bit):
//   16 bit lossless sources:  v >= 0 -> f = v / 32767,  v < 0 -> f = v / 32768
//   24 bit lossless sources:  f = v / 2^23 in both polarities (exact)
//
// Because the scale differs per polarity, multiplying the decoded float by the
// container scale (2^(bits-1)) does not always reproduce the original integer
// sample: half of all 16 bit samples would be off by one LSB.  That single LSB
// is what separates "plays through WASAPI exclusive" from "bit perfect".
//
// The scale is a property of the decoder output sample format, which depends on
// the codec (integer PCM vs float PCM vs lossy).  Instead of hard coding a rule
// per codec, the scale is measured from the decoded audio itself: a correctly
// normalized integer sample lands on an exact integer when multiplied by the
// scale that was used, so the two plausible scales (2^(bits-1) and
// 2^(bits-1)-1) can be told apart by their distance to the nearest integer.

export interface PcmNormalization {
  bits: number
  /** Scale used by the decoder for non negative samples (e.g. 32767). */
  positiveScale: number
  /** Scale used by the decoder for negative samples (e.g. 32768). */
  negativeScale: number
  /** Multiply positive samples by this gain to restore v / 2^(bits-1). */
  positiveGain: number
  negativeGain: number
  /** True when the detected scales reproduce integer samples exactly. */
  exact: boolean
}

const MAX_SAMPLES_PER_PLANE = 16384
// Fractional distance to the nearest integer below which a scale is considered
// to be the one the decoder used.  The wrong candidate scores ~0.3 on average,
// so the margin is huge.
const SCALE_TOLERANCE = 0.02

function scoreCandidate(
  planes: Float32Array[],
  scale: number,
  positive: boolean,
): { meanError: number; samples: number } {
  let error = 0
  let samples = 0
  for (const plane of planes) {
    // Step across the whole plane instead of only reading its head: quiet or
    // one sided intros must not hide the integer grid.
    const step = Math.max(1, Math.floor(plane.length / MAX_SAMPLES_PER_PLANE))
    for (let index = 0; index < plane.length; index += step) {
      const value = plane[index]
      if (!Number.isFinite(value)) continue
      if (positive ? value < 0 : value >= 0) continue
      const scaled = value * scale
      error += Math.abs(scaled - Math.round(scaled))
      samples += 1
    }
  }
  return { meanError: samples > 0 ? error / samples : Number.POSITIVE_INFINITY, samples }
}

/**
 * Returns the normalization used by the decoder for `bits` bit integer PCM, or
 * null when the decoded data does not look like integer PCM (lossy content,
 * float PCM, already compensated material).
 */
export function detectPcmNormalization(
  planes: Float32Array[],
  bits: number,
): PcmNormalization | null {
  if (!Array.isArray(planes) || planes.length === 0) return null
  if (bits < 8 || bits > 32) return null

  const half = Math.pow(2, bits - 1)
  const candidates = [half, half - 1]

  const positiveScores = candidates.map((scale) => scoreCandidate(planes, scale, true))
  const negativeScores = candidates.map((scale) => scoreCandidate(planes, scale, false))

  const pick = (scores: Array<{ meanError: number; samples: number }>): number | null => {
    let bestIndex = -1
    for (let index = 0; index < scores.length; index += 1) {
      if (scores[index].samples === 0) continue
      if (bestIndex < 0 || scores[index].meanError < scores[bestIndex].meanError) {
        bestIndex = index
      }
    }
    // No samples of this polarity: keep the symmetric scale (gain 1).
    if (bestIndex < 0) return half
    if (scores[bestIndex].meanError > SCALE_TOLERANCE) {
      // Neither candidate fits: not integer PCM (lossy or float source).
      return null
    }
    return candidates[bestIndex]
  }

  const positiveScale = pick(positiveScores)
  const negativeScale = pick(negativeScores)
  if (positiveScale == null || negativeScale == null) return null

  return {
    bits,
    positiveScale,
    negativeScale,
    positiveGain: positiveScale / half,
    negativeGain: negativeScale / half,
    exact: true,
  }
}

/** True when the normalization needs a per-sample gain (i.e. it is asymmetric). */
export function normalizationNeedsGain(normalization: PcmNormalization | null): boolean {
  if (!normalization) return false
  return Math.abs(normalization.positiveGain - 1) > 1e-9
    || Math.abs(normalization.negativeGain - 1) > 1e-9
}
