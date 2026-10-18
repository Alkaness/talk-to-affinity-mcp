// Host side of file transfer through Affinity's Desktop folder (specs/004-files-export/plan.md section 3).
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { AffinityError, type Upstream } from './affinity.js';

export const FOLDER = 'talk-to-affinity';
export const ACCESS_FIX = 'Turn on Settings > Model Context Protocol > Access files on your Desktop in Affinity.';
const LOCATE_FIX = "Set AFFINITY_DESKTOP_DIR to the host folder that Affinity calls its Desktop.";
const ORIGIN = 'origin.txt';
const hex = () => randomBytes(4).toString('hex');
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** FR-401: an absolute host path, or one starting with ~. */
export function hostPath(p: string): string {
  const expanded = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  if (!isAbsolute(expanded)) throw new AffinityError(`"${p}" is not a path on this computer. Paths are absolute, or start with ~ for the home folder.`);
  return resolve(expanded);
}

/** FR-405: the folder must exist; an existing file is replaced only with overwrite. */
export function checkTarget(file: string, overwrite = false) {
  checkFolder(dirname(file));
  if (existsSync(file) && !overwrite) throw new AffinityError(`${file} exists. Set overwrite: true to replace it.`);
}

export function checkFolder(dir: string) {
  if (!isDir(dir)) throw new AffinityError(`The folder ${dir} does not exist.`);
}

function isDir(p: string) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** FR-403: host folders that may be Affinity's Desktop, in the order of the spec. */
export function candidates(reported: string, env = process.env): string[] {
  const home = homedir();
  const out = [env.AFFINITY_DESKTOP_DIR, reported];
  const drive = /^c:[\\/](.*)$/i.exec(reported);
  if (drive) {
    const rest = drive[1].replace(/\\/g, '/');
    for (const prefix of [env.WINEPREFIX, join(home, '.wine'), join(home, '.local', 'share', 'affinity-infinity', 'prefix')]) if (prefix) out.push(join(prefix, 'drive_c', rest));
  }
  let xdg = env.XDG_DESKTOP_DIR;
  if (!xdg) {
    try {
      xdg = /^XDG_DESKTOP_DIR="(.*)"/m.exec(readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8'))?.[1].replace('$HOME', home);
    } catch {}
  }
  out.push(xdg, join(home, 'Desktop'));
  return out.filter((c): c is string => !!c);
}

export interface Located {
  desktop: string; // Affinity's Desktop path
  host: string; // the same folder on the host
}

export class Staging {
  located?: Located;

  constructor(private readonly upstream: Upstream) {}

  private async script<T>(call: string): Promise<T> {
    return (await this.upstream.runScript(`return ${call};`, { readOnly: false, timeoutMs: 60000 })).result as T;
  }

  /** FR-402, FR-403: file access on, and the Desktop found on the host. Runs once per file call. */
  async begin(): Promise<Located> {
    for (;;) {
      const known = this.located;
      const probe = known ? null : `probe-${hex()}.txt`;
      const r = await this.script<{ access: boolean; desktop: string }>(`ttam.fileAccess(${JSON.stringify(probe)})`);
      if (!r.access) throw new AffinityError('Affinity does not allow scripts to access files.', ACCESS_FIX);
      if (known) {
        if (known.desktop === r.desktop) return known;
        this.located = undefined; // the reported path changed: probe again
        continue;
      }
      // ponytail: on a miss the probe stays in Affinity's unmapped Desktop; nothing on this host can remove it.
      const host = candidates(r.desktop).find((c) => existsSync(join(c, FOLDER, probe!)));
      if (!host) throw new AffinityError(`Affinity's Desktop ${r.desktop} was not found on this computer.`, LOCATE_FIX);
      rmSync(join(host, FOLDER, probe!), { force: true });
      this.located = { desktop: r.desktop, host };
      this.tidy();
      return this.located;
    }
  }

  /** Locates quietly for path mapping; undefined when it fails. */
  async tryLocate(): Promise<Located | undefined> {
    return this.located ?? (await this.begin().catch(() => undefined));
  }

  private root(l = this.located!) {
    return { host: join(l.host, FOLDER), affinity: `${l.desktop}/${FOLDER}` };
  }

  /** Removes the staging folder when it is empty (FR-404). */
  tidy() {
    if (!this.located) return;
    try {
      rmdirSync(this.root().host);
    } catch {}
  }

  /** FR-404: a call folder (host path and Affinity path), removed when fn ends; stage copies a host file in. */
  async withCall<T>(fn: (call: { host: string; dir: string; stage: (file: string) => string }) => Promise<T>): Promise<T> {
    const r = this.root();
    const name = `call-${hex()}`;
    const host = join(r.host, name);
    const dir = `${r.affinity}/${name}`;
    mkdirSync(host, { recursive: true });
    let n = 0;
    try {
      return await fn({
        host,
        dir,
        stage: (file) => {
          const staged = `${++n}-${basename(file)}`;
          cpSync(file, join(host, staged));
          return `${dir}/${staged}`;
        },
      });
    } finally {
      rmSync(host, { recursive: true, force: true });
      this.tidy();
    }
  }

  /** A document folder with its origin (plan 3.4); returns the Affinity path of the copy and the host folder. */
  newCopy(origin: string, copyFrom?: string) {
    const r = this.root();
    const name = `doc-${hex()}`;
    const folder = join(r.host, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, ORIGIN), origin);
    if (copyFrom) cpSync(copyFrom, join(folder, basename(origin)), { preserveTimestamps: true });
    return { folder, affinity: `${r.affinity}/${name}/${basename(origin)}`, host: join(folder, basename(origin)) };
  }

  /** The document folder holding Affinity path p, if any. */
  private copyOf(p: string) {
    if (!this.located || !p) return undefined;
    const r = this.root();
    const m = new RegExp('^' + norm(r.affinity).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(doc-[0-9a-f]+)/[^/]+$').exec(norm(p));
    if (!m) return undefined;
    const folder = join(r.host, m[1]);
    try {
      const origin = readFileSync(join(folder, ORIGIN), 'utf8');
      return { folder, origin, copy: join(folder, basename(origin)) };
    } catch {
      return undefined;
    }
  }

  /** FR-423: the host path of an Affinity path. */
  mapPath(p: string | null | undefined): string | null {
    if (!p) return null;
    const c = this.copyOf(p);
    if (c) return c.origin;
    const l = this.located;
    if (l && (norm(p) + '/').startsWith(norm(l.desktop) + '/')) return join(l.host, p.slice(l.desktop.length).replace(/\\/g, '/'));
    return p;
  }

  /** FR-408: writes the copy of Affinity path p to its origin; false when p is not a copy. */
  writeBack(p: string): boolean {
    const c = this.copyOf(p);
    if (!c) return false;
    cpSync(c.copy, c.origin, { preserveTimestamps: true });
    return true;
  }

  /** FR-411: writes back and removes the copies of documents that are no longer open; returns warnings. */
  sync(open: string[]): string[] {
    if (!this.located) return [];
    const r = this.root();
    const openSet = new Set(open.map(norm));
    const warnings: string[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(r.host).filter((n) => /^doc-[0-9a-f]+$/.test(n));
    } catch {}
    for (const name of names) {
      const c = this.copyOf(`${r.affinity}/${name}/x`);
      if (!c) continue;
      if (openSet.has(norm(`${r.affinity}/${name}/${basename(c.origin)}`))) continue;
      try {
        const newer = existsSync(c.copy) && (!existsSync(c.origin) || statSync(c.copy).mtimeMs > statSync(c.origin).mtimeMs);
        if (newer) cpSync(c.copy, c.origin, { preserveTimestamps: true });
        rmSync(c.folder, { recursive: true, force: true });
      } catch (e) {
        warnings.push(`The saved copy ${c.copy} could not be written to ${c.origin} (${(e as Error).message}); it was kept.`);
      }
    }
    this.tidy();
    return warnings;
  }
}
