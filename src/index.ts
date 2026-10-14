#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Upstream } from './affinity.js';
import { createServer } from './tools.js';

const upstream = new Upstream();
await createServer(upstream).connect(new StdioServerTransport());
// FR-131: the SDK's stdio transport ignores the end of input; the open SSE session would keep the process alive.
process.stdin.once('end', () => void upstream.close().finally(() => process.exit(0)));
