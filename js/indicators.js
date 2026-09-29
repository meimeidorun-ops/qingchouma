// Pure technical-indicator math. Inputs are plain number arrays aligned to
// priceRows order; outputs are arrays of the same length (nulls where the
// indicator isn't defined yet, e.g. the warm-up period).

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) { out.push(null); continue; }
    prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// Standard 9,3,3 KD (Stochastic Oscillator) used on the TW market.
function computeKD(highs, lows, closes, period = 9, kSmooth = 3, dSmooth = 3) {
  const rsv = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { rsv.push(null); continue; }
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > hi) hi = highs[j];
      if (lows[j] < lo) lo = lows[j];
    }
    rsv.push(hi === lo ? 50 : ((closes[i] - lo) / (hi - lo)) * 100);
  }

  const k = [];
  const d = [];
  let prevK = 50, prevD = 50;
  for (let i = 0; i < rsv.length; i++) {
    if (rsv[i] == null) { k.push(null); d.push(null); continue; }
    prevK = (prevK * (kSmooth - 1) + rsv[i]) / kSmooth;
    prevD = (prevD * (dSmooth - 1) + prevK) / dSmooth;
    k.push(prevK);
    d.push(prevD);
  }
  return { k, d };
}

function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macd = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null);
  const signalLine = ema(macd, signal);
  const hist = macd.map((v, i) => (v != null && signalLine[i] != null) ? v - signalLine[i] : null);
  return { macd, signal: signalLine, hist };
}

function computeBollingerBands(closes, period = 20, mult = 2) {
  const upper = [], mid = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { upper.push(null); mid.push(null); lower.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper.push(mean + mult * sd);
    mid.push(mean);
    lower.push(mean - mult * sd);
  }
  return { upper, mid, lower };
}
