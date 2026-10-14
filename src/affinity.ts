// Client side of Affinity's native MCP endpoint (specs/001-foundation/plan.md section 3).
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const VERSION: string = createRequire(import.meta.url)('../../package.json').version;
export const FIX = 'Enable it in Affinity under Settings > Model Context Protocol > Enable MCP server, then restart Affinity.';
const DEFAULT_URLS = ['http://127.0.0.1:6767/sse', 'http://[::1]:6767/sse']; // R-01: Wine binds IPv4 only
const GATE = /^(ERROR: )?The preamble documentation topic has not yet been read\.$/; // R-03
const PRELUDE = readFileSync(new URL('./sdk.js', import.meta.url), 'utf8');
const SDK_DIR_SUFFIX = join('drive_c', 'Program Files', 'Affinity', 'Affinity', 'Resources', 'JSLib');

/** A failure to reach or keep Affinity; the message is meant for the user. */
export class AffinityError extends Error {
  constructor(
    readonly reason: string,
    readonly fix?: string,
  ) {
    super(fix ? `${reason} ${fix}` : reason);
  }
}

/** A script that ran but failed; details come from the envelope. */
export class ScriptError extends Error {
  constructor(
    message: string,
    readonly details: { stack?: string; logs?: string[]; undoSteps?: number; raw?: string },
  ) {
    super(message);
  }
}

export interface CallOptions {
  readOnly: boolean;
  timeoutMs?: number;
}

export interface ScriptResult {
  result: unknown;
  logs: string[];
  dropped?: number;
}

export const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
const describe = (e: unknown) => (e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e));
const docFailed = (r: CallToolResult) => r.isError === true || /^(ERROR:|File not found|Listing failed)/.test(textOf(r).trim());

/** Envelope text for `body` (FR-108). The body is inserted with a function so `$` sequences stay literal. */
export function wrapScript(body: string, nonce: string): string {
  return PRELUDE.replace('__NONCE__', nonce).replace('__BODY__', () => body);
}

/** Reads the envelope line (FR-109 to FR-112). */
export function parseOutput(text: string, nonce: string): ScriptResult {
  const line = text.split('\n').find((l) => l.startsWith(nonce));
  if (line === undefined) throw new ScriptError('The script produced no result; it probably has a syntax error.', { raw: text.trim().slice(0, 8000) });
  const out = JSON.parse(line.slice(nonce.length));
  if (!out.ok) throw new ScriptError(out.error, out);
  return { result: out.result, logs: out.logs, ...(out.dropped ? { dropped: out.dropped } : {}) };
}

function isDir(p: string) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((e) => {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      return e.isDirectory() ? listFiles(dir, rel) : e.isFile() ? [rel] : [];
    })
    .sort();
}

export class Upstream {
  private session?: { client: Client; url: string };
  private pending?: Promise<{ client: Client; url: string }>;
  private docs = new Map<string, { source: string; text: string }>();
  private localDir?: string | null;

  constructor(
    readonly urls: string[] = process.env.AFFINITY_MCP_URL ? [process.env.AFFINITY_MCP_URL] : DEFAULT_URLS,
    private readonly budgetMs = 3000,
  ) {}

  get url() {
    return this.session?.url;
  }

  async connect() {
    if (this.session) return this.session;
    this.pending ??= this.open().finally(() => (this.pending = undefined));
    return this.pending;
  }

  async close() {
    const s = this.session;
    this.session = undefined;
    await s?.client.close().catch(() => {});
  }

  private async open() {
    const tried: string[] = [];
    const share = this.budgetMs / this.urls.length;
    for (const url of this.urls) {
      const client = new Client({ name: 'talk-to-affinity-mcp', version: VERSION });
      const transport = new SSEClientTransport(new URL(url));
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(share)} ms`)), share);
        });
        const connecting = client.connect(transport);
        connecting.catch(() => {}); // when the timeout wins, a late rejection must not become unhandled
        await Promise.race([connecting, timeout]);
      } catch (e) {
        await transport.close().catch(() => {}); // FR-104: stops the EventSource retry loop (R-18)
        tried.push(`${url}: ${describe(e)}`);
        continue;
      } finally {
        clearTimeout(timer);
      }
      // A dropped stream would make the EventSource reconnect into a fresh, ungated session (plan 3.1 item 6).
      // Deferred, so a failed POST rejects its own request before the session closes.
      client.onerror = (e) => {
        if (e instanceof SseError) setImmediate(() => this.drop(client));
      };
      client.onclose = () => {
        if (this.session?.client === client) this.session = undefined;
      };
      this.session = { client, url };
      await this.readPreamble(client);
      return this.session;
    }
    throw new AffinityError(`Affinity is not reachable (tried ${tried.join('; ')}).`, FIX);
  }

  private drop(client: Client) {
    if (this.session?.client === client) this.session = undefined;
    void client.close().catch(() => {});
  }

  protected async readPreamble(client: Client) {
    // FR-107: the read may fail ("File not found") and still opens the gate (R-03, R-16).
    await client.callTool({ name: 'read_sdk_documentation_topic', arguments: { filename: 'preamble' } }, undefined, { timeout: 10000 }).catch(() => {});
  }

  /** One native tool call with the retry rules of plan section 3.2. */
  async call(name: string, args: Record<string, unknown>, { readOnly, timeoutMs = 60000 }: CallOptions): Promise<CallToolResult> {
    let gateRetried = false;
    let reconnected = false;
    for (;;) {
      const { client } = await this.connect();
      try {
        const res = (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as CallToolResult;
        if (!gateRetried && GATE.test(textOf(res).trim())) {
          gateRetried = true; // FR-130: the call was refused, so it did not run
          await this.readPreamble(client);
          continue;
        }
        return res;
      } catch (e) {
        if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) {
          throw new AffinityError(
            readOnly
              ? `Affinity did not answer within ${timeoutMs} ms.`
              : `Affinity did not answer within ${timeoutMs} ms. The script may have run or may still be running; inspect the document (get_status, render) before retrying.`,
          ); // FR-106
        }
        const inFlight = e instanceof McpError && e.code === ErrorCode.ConnectionClosed;
        if (e instanceof McpError && !inFlight) throw e; // Affinity answered with a protocol error
        this.drop(client);
        if (!reconnected && (readOnly || !inFlight)) {
          reconnected = true; // FR-105
          continue;
        }
        throw new AffinityError(
          inFlight
            ? 'The connection to Affinity closed while the script was running. It may have run; inspect the document before retrying.'
            : `Lost the connection to Affinity: ${describe(e)}.`,
          inFlight ? undefined : FIX,
        );
      }
    }
  }

  /** Runs `body` inside the envelope and returns its result (FR-108 to FR-114). */
  async runScript(body: string, opts: CallOptions): Promise<ScriptResult> {
    const nonce = `ttam:${randomBytes(6).toString('hex')}:`;
    const res = await this.call('execute_script', { script: wrapScript(body, nonce) }, opts);
    if (res.isError) throw new ScriptError(textOf(res) || 'execute_script failed.', {});
    return parseOutput(textOf(res), nonce);
  }

  // Documentation (plan section 3.4)

  private sdkDir(): string | null {
    if (this.localDir !== undefined) return this.localDir;
    const home = homedir();
    const candidates = [
      process.env.AFFINITY_SDK_DIR,
      process.env.WINEPREFIX && join(process.env.WINEPREFIX, SDK_DIR_SUFFIX),
      join(home, '.local', 'share', 'affinity-infinity', 'prefix', SDK_DIR_SUFFIX),
      join(home, '.wine', SDK_DIR_SUFFIX),
      'C:\\Program Files\\Affinity\\Affinity\\Resources\\JSLib',
      '/Applications/Affinity.app/Contents/Resources/JSLib', // unverified
    ];
    this.localDir = candidates.find((c): c is string => !!c && isDir(c)) ?? null;
    return this.localDir;
  }

  private requireSdkDir(): string {
    const dir = this.sdkDir();
    if (!dir) throw new AffinityError('SDK documentation is unavailable: the endpoint could not serve it and no local JSLib folder was found.', "Set AFFINITY_SDK_DIR to Affinity's Resources/JSLib folder.");
    return dir;
  }

  /** Native call that falls back (returns undefined) when Affinity is unreachable or the documentation fails. */
  private async nativeDoc(name: string, args: Record<string, unknown>) {
    try {
      const res = await this.call(name, args, { readOnly: true, timeoutMs: 15000 });
      return docFailed(res) ? undefined : textOf(res);
    } catch (e) {
      if (e instanceof AffinityError) return undefined;
      throw e;
    }
  }

  async listTopics(): Promise<{ source: string; topics: string[] }> {
    const native = await this.nativeDoc('list_sdk_documentation', {});
    if (native !== undefined) return { source: 'native', topics: native.split(',').map((s) => s.trim()).filter(Boolean) };
    const dir = this.requireSdkDir();
    return { source: `local (${dir})`, topics: listFiles(dir) };
  }

  async readTopic(topic: string): Promise<{ source: string; text: string }> {
    const cached = this.docs.get(topic);
    if (cached) return cached;
    const native = await this.nativeDoc('read_sdk_documentation_topic', { filename: topic });
    let doc: { source: string; text: string };
    if (native !== undefined) {
      doc = { source: 'native', text: native };
    } else {
      const dir = resolve(this.requireSdkDir());
      const file = resolve(dir, topic);
      if (!file.startsWith(dir + sep)) throw new AffinityError(`Topic "${topic}" is outside the SDK folder.`);
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text === undefined) throw new AffinityError(`Topic "${topic}" was not found.`);
      doc = { source: `local (${dir})`, text: text.replace(/\r\n/g, '\n') };
    }
    this.docs.set(topic, doc);
    return doc;
  }
}
