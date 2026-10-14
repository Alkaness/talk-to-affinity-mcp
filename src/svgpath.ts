// SVG path data to subpaths of absolute line and cubic segments (specs/003-write-model/spec.md FR-310).
export type Segment = ['L', number, number] | ['C', number, number, number, number, number, number];
export interface Subpath {
  start: [number, number];
  segments: Segment[];
  closed: boolean;
}

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const SPACE = /[\s,]*/y;

/** Parses `d`; throws an Error naming the problem. Quadratics become exact cubics, arcs cubics of at most 90 degrees. */
export function parsePath(d: string): Subpath[] {
  let i = 0;
  const skip = () => {
    SPACE.lastIndex = i;
    SPACE.exec(d);
    i = SPACE.lastIndex;
  };
  const number = (cmd: string) => {
    skip();
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(d);
    if (!m) throw new Error(`Path command "${cmd}" expects ${ARGS[cmd.toUpperCase()]} numbers (at character ${i}).`);
    i = NUMBER.lastIndex;
    return Number(m[0]);
  };
  const flag = () => {
    skip();
    const c = d[i++];
    if (c !== '0' && c !== '1') throw new Error(`Arc flag must be 0 or 1 (at character ${i - 1}).`);
    return c === '1';
  };

  const paths: Subpath[] = [];
  let path: Subpath | undefined;
  let x = 0;
  let y = 0;
  let cubic: [number, number] | undefined; // last cubic control point, for S
  let quad: [number, number] | undefined; // last quadratic control point, for T
  const segment = (s: Segment) => {
    if (!path) throw new Error('Path data must start with M.');
    if (path.closed) {
      path = { start: [...path.start] as [number, number], segments: [], closed: false };
      paths.push(path);
    }
    path.segments.push(s);
    [x, y] = s.length === 3 ? [s[1], s[2]] : [s[5], s[6]];
  };

  skip();
  if (i >= d.length) throw new Error('Path data is empty.');
  let cmd = '';
  while (i < d.length) {
    const c = d[i];
    if (/[A-Za-z]/.test(c)) {
      if (!(c.toUpperCase() in ARGS)) throw new Error(`Unknown command "${c}" in path data (at character ${i}).`);
      cmd = c;
      i++;
    } else if (!cmd) {
      throw new Error('Path data must start with M.');
    } else if (cmd === 'M') {
      cmd = 'L'; // pairs after a move-to are line-tos
    } else if (cmd === 'm') {
      cmd = 'l';
    }
    if (!path && cmd.toUpperCase() !== 'M') throw new Error('Path data must start with M.');
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    const up = cmd.toUpperCase();
    const prevCubic = cubic;
    const prevQuad = quad;
    cubic = quad = undefined;
    switch (up) {
      case 'M': {
        const nx = ox + number(cmd);
        const ny = oy + number(cmd);
        if (path && !path.segments.length && !path.closed) paths.pop();
        path = { start: [nx, ny], segments: [], closed: false };
        paths.push(path);
        [x, y] = [nx, ny];
        break;
      }
      case 'Z':
        if (path) {
          path.closed = true;
          [x, y] = path.start;
        }
        cmd = ''; // numbers after Z are an error
        break;
      case 'L':
        segment(['L', ox + number(cmd), oy + number(cmd)]);
        break;
      case 'H':
        segment(['L', ox + number(cmd), y]);
        break;
      case 'V':
        segment(['L', x, oy + number(cmd)]);
        break;
      case 'C': {
        const s: Segment = ['C', ox + number(cmd), oy + number(cmd), ox + number(cmd), oy + number(cmd), ox + number(cmd), oy + number(cmd)];
        segment(s);
        cubic = [s[3], s[4]];
        break;
      }
      case 'S': {
        const [c1x, c1y] = prevCubic ? [2 * x - prevCubic[0], 2 * y - prevCubic[1]] : [x, y];
        const s: Segment = ['C', c1x, c1y, ox + number(cmd), oy + number(cmd), ox + number(cmd), oy + number(cmd)];
        segment(s);
        cubic = [s[3], s[4]];
        break;
      }
      case 'Q':
      case 'T': {
        const q: [number, number] = up === 'Q' ? [ox + number(cmd), oy + number(cmd)] : prevQuad ? [2 * x - prevQuad[0], 2 * y - prevQuad[1]] : [x, y];
        const ex = ox + number(cmd);
        const ey = oy + number(cmd);
        segment(['C', x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y), ex + (2 / 3) * (q[0] - ex), ey + (2 / 3) * (q[1] - ey), ex, ey]);
        quad = q;
        break;
      }
      case 'A': {
        const rx = number(cmd);
        const ry = number(cmd);
        const phi = number(cmd);
        const large = flag();
        const sweep = flag();
        const ex = ox + number(cmd);
        const ey = oy + number(cmd);
        if (!path) throw new Error('Path data must start with M.');
        for (const s of arc(x, y, rx, ry, phi, large, sweep, ex, ey)) segment(s);
        break;
      }
    }
    skip();
  }
  return paths;
}

/** Endpoint arc to cubic segments (SVG 1.1 implementation notes F.6.5 and F.6.6). */
function arc(x1: number, y1: number, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): Segment[] {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) return [['L', x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t: number) => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const tangent = (t: number) => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const out: Segment[] = [];
  for (let j = 0; j < n; j++) {
    const t1 = theta + j * step;
    const t2 = t1 + step;
    const [ax, ay] = point(t1);
    const [bx, by] = j === n - 1 ? [x2, y2] : point(t2);
    const [d1x, d1y] = tangent(t1);
    const [d2x, d2y] = tangent(t2);
    out.push(['C', ax + k * d1x, ay + k * d1y, bx - k * d2x, by - k * d2y, bx, by]);
  }
  return out;
}
