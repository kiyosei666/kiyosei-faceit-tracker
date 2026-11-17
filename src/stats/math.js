// Small, dependency-free statistics helpers.
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1));
}
const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : +v.toFixed(d));

// Wilson score interval for a proportion (95%).
function wilson(wins, n, z = 1.96) {
  if (!n) return null;
  const p = wins / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

// Welch z-statistic for a difference in means (normal approximation).
function welchZ(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const se = Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
  return se > 0 ? (mean(a) - mean(b)) / se : null;
}

// Two-proportion z-statistic.
function propZ(w1, n1, w2, n2) {
  if (!n1 || !n2) return null;
  const p = (w1 + w2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? (w1 / n1 - w2 / n2) / se : null;
}

/** Plain-language strength of evidence from a z-statistic. */
function significance(z) {
  if (z === null || z === undefined) return "insufficient";
  const a = Math.abs(z);
  return a >= 2.58 ? "clear" : a >= 2 ? "likely" : a >= 1.5 ? "possible" : "none";
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const percentRank = (arr, v) => (arr.length ? arr.filter((x) => x < v).length / arr.length : null);

module.exports = { sum, mean, sd, round, wilson, welchZ, propZ, significance, clamp01, percentRank };
