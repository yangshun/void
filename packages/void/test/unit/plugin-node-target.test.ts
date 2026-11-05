import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { nodeTargetPlugin } from '../../src/plugin-node-target.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

const tempDirs: Array<string> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function servePlugin(): Plugin {
  const plugin = nodeTargetPlugin('node').find((p) => p.configureServer);
  if (!plugin) {
    throw new Error('Expected the node target serve plugin.');
  }
  return plugin;
}

async function requestThrough(middleware: Middleware, path: string): Promise<Response> {
  const server = createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    await response.text();
    return response;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('nodeTargetPlugin request bridge', () => {
  it('keeps every Set-Cookie header in dev', async () => {
    let middleware: Middleware | undefined;
    const app = {
      fetch: async () => {
        const headers = new Headers({ 'content-type': 'text/plain' });
        headers.append('set-cookie', 'session=abc; Path=/');
        headers.append('set-cookie', 'csrf=xyz; Path=/');
        return new Response('ok', { headers });
      },
    };
    const server = {
      middlewares: { use: (fn: Middleware) => (middleware = fn) },
      ssrLoadModule: async () => ({ default: app }),
    } as unknown as ViteDevServer;
    getHookHandler(servePlugin().configureServer)!.call({} as never, server);

    const response = await requestThrough(middleware!, '/login');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.getSetCookie()).toEqual(['session=abc; Path=/', 'csrf=xyz; Path=/']);
  });

  it('keeps every Set-Cookie header in preview', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-node-target-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'dist', 'ssr'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'ssr', 'app.js'),
      `export default {
  fetch: async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'session=abc; Path=/');
    headers.append('set-cookie', 'csrf=xyz; Path=/');
    return new Response('ok', { headers });
  },
};
`,
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    let middleware: Middleware | undefined;
    const server = {
      middlewares: { use: (fn: Middleware) => (middleware = fn) },
    } as unknown as PreviewServer;
    getHookHandler(servePlugin().configurePreviewServer)!.call({} as never, server);

    const response = await requestThrough(middleware!, '/login');

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(['session=abc; Path=/', 'csrf=xyz; Path=/']);
  });
});

function guardPlugin(target: Parameters<typeof nodeTargetPlugin>[0]): Plugin {
  const plugin = nodeTargetPlugin(target).find((p) => p.name === 'void:node-target');
  if (!plugin) {
    throw new Error('Expected the node target guard plugin.');
  }
  return plugin;
}

type BuildConfig = {
  ssr: { noExternal: unknown };
  build?: { ssr?: boolean; rollupOptions?: { input: Record<string, string>; external: unknown } };
};

function buildConfig(target: Parameters<typeof nodeTargetPlugin>[0]): BuildConfig {
  const root = mkdtempSync(join(tmpdir(), 'void-node-target-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'package.json'), '{ "name": "app" }');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const config = getHookHandler(guardPlugin(target).config)!;
  return config.call({} as never, {}, { command: 'build', mode: 'production' }) as BuildConfig;
}

describe('nodeTargetPlugin for Vercel', () => {
  it('rejects void/queues, which Vercel cannot deliver', () => {
    const resolveId = guardPlugin('vercel').resolveId as { filter: { id: RegExp } };
    expect(resolveId.filter.id.test('void/queues')).toBe(true);
    expect(resolveId.filter.id.test('void/db')).toBe(true);
    expect(
      (guardPlugin('node').resolveId as { filter: { id: RegExp } }).filter.id.test('void/queues'),
    ).toBe(false);
  });

  it('bundles every dependency into a single function entry', () => {
    const config = buildConfig('vercel');
    expect(config.ssr.noExternal).toBe(true);
    expect(Object.keys(config.build!.rollupOptions!.input)).toEqual(['app']);
    expect(config.build!.rollupOptions!.external).toEqual([/^node:/]);
  });

  it('keeps the Node server entry and its external server package for target node', () => {
    const config = buildConfig('node');
    expect(Array.isArray(config.ssr.noExternal)).toBe(true);
    expect(Object.keys(config.build!.rollupOptions!.input)).toEqual(['app', 'index']);
  });
});
