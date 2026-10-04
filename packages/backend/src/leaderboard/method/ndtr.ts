// Standard normal CDF (Cephes ndtr/erf/erfc, double precision). Net support uses 2Φ(z) − 1,
// and the published method was computed with this same routine (SciPy's norm.cdf).
const P = [2.46196981473530512524e-10, 5.64189564831068821977e-1, 7.46321056442269912687e0, 4.86371970985681366614e1, 1.96520832956077098242e2, 5.26445194995477358631e2, 9.34528527171957607540e2, 1.02755188689515710272e3, 5.57535335369399327526e2];
const Q = [1.32281951154744992508e1, 8.67072140885989742329e1, 3.54937778887819891062e2, 9.75708501743205489753e2, 1.82390916687909736289e3, 2.24633760818710981792e3, 1.65666309194161350182e3, 5.57535340817727675546e2];
const R = [5.64189583547755073984e-1, 1.27536670759978104416e0, 5.01905042251180477414e0, 6.16021097993053585195e0, 7.40974269950448939160e0, 2.97886665372100240670e0];
const S = [2.26052863220117276590e0, 9.39603524938001434673e0, 1.20489539808096656605e1, 1.70814450747565897222e1, 9.60896809063285878198e0, 3.36907645100081516050e0];
const T = [9.60497373987051638749e0, 9.00260197203842689217e1, 2.23200534594684319226e3, 7.00332514112805075473e3, 5.55923013010394962768e4];
const U = [3.35617141647503099647e1, 5.21357949780152679795e2, 4.59432382970980127987e3, 2.26290000613890934246e4, 4.92673942608635921086e4];
const MAXLOG = 7.09782712893383996843e2;

function polevl(x: number, c: number[]): number {
  let a = c[0]!;
  for (let i = 1; i < c.length; i++) a = a * x + c[i]!;
  return a;
}

function p1evl(x: number, c: number[]): number {
  let a = x + c[0]!;
  for (let i = 1; i < c.length; i++) a = a * x + c[i]!;
  return a;
}

export function erf(x: number): number {
  if (Math.abs(x) > 1) return 1 - erfc(x);
  const z = x * x;
  return (x * polevl(z, T)) / p1evl(z, U);
}

export function erfc(a: number): number {
  const x = Math.abs(a);
  if (x < 1) return 1 - erf(a);
  const z0 = -a * a;
  if (z0 < -MAXLOG) return a < 0 ? 2 : 0;
  const z = Math.exp(z0);
  const p = x < 8 ? polevl(x, P) : polevl(x, R);
  const q = x < 8 ? p1evl(x, Q) : p1evl(x, S);
  let y = (z * p) / q;
  if (a < 0) y = 2 - y;
  if (y === 0) return a < 0 ? 2 : 0;
  return y;
}

export function ndtr(a: number): number {
  const x = a * Math.SQRT1_2;
  const z = Math.abs(x);
  if (z < Math.SQRT1_2) return 0.5 + 0.5 * erf(x);
  const y = 0.5 * erfc(z);
  return x > 0 ? 1 - y : y;
}
