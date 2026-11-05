import { timingSafeEqual } from 'node:crypto';
/**
 * Runtime for `target: 'vercel'`: the Vercel Function's fetch handler around the
 * generated route table. Vercel's CDN serves static files first, so the function
 * reads only the client files the build copied into it (the Vite manifest, error
 * pages and rewrite destinations); `vite preview` and the build-time prerender
 * runner use the same entry over the whole client build.
 */
import { readFile, stat } from 'node:fs/promises';
import { getContentType } from '@void/edge';
import { resolve } from 'pathslash';

type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: Record<string, unknown>;
};

type FetchApp = {
  fetch(request: Request, env?: unknown, ctx?: ExecutionContextLike): Response | Promise<Response>;
};

type ScheduledController = {
  cron: string;
  scheduledTime: number;
  type: 'scheduled';
  noRetry(): void;
};

export type AssetFetcher = { fetch(request: Request): Promise<Response> };

/** The path Vercel Cron Jobs call; keep in sync with `@void/deploy-vercel`. */
export const VERCEL_CRON_PATH = '/__void/cron';

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}

/** Serve files under `root` as the Workers `ASSETS` binding would, for GET and HEAD. */
export function createFileAssets(root: string): AssetFetcher {
  const base = resolve(root);
  const read = async (path: string): Promise<{ path: string; size: number } | null> => {
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) {
      return { path, size: info.size };
    }
    if (info?.isDirectory()) {
      const index = resolve(path, 'index.html');
      const indexInfo = await stat(index).catch(() => null);
      return indexInfo?.isFile() ? { path: index, size: indexInfo.size } : null;
    }
    return null;
  };
  return {
    async fetch(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return notFound();
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return notFound();
      }
      const target = resolve(base, `.${pathname}`);
      if (target !== base && !target.startsWith(`${base}/`)) {
        return notFound();
      }
      const file = await read(target);
      if (!file) {
        return notFound();
      }
      const headers = {
        'content-type': getContentType(file.path),
        'content-length': String(file.size),
      };
      if (request.method === 'HEAD') {
        return new Response(null, { headers });
      }
      return new Response(await readFile(file.path), { headers });
    },
  };
}

type VercelRequestContext = { waitUntil?: (promise: Promise<unknown>) => void };

function vercelRequestContext(context: unknown): VercelRequestContext | undefined {
  if (
    context &&
    typeof context === 'object' &&
    typeof (context as VercelRequestContext).waitUntil === 'function'
  ) {
    return context as VercelRequestContext;
  }
  // Vercel's request context, also behind `@vercel/functions`.
  const store = (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] as
    | { get?: () => VercelRequestContext | undefined }
    | undefined;
  return store?.get?.();
}

/**
 * An execution context whose `waitUntil` keeps the function alive for the
 * promise on Vercel. Elsewhere (preview, prerendering) the promise only runs.
 */
export function createExecutionContext(context?: unknown): ExecutionContextLike {
  const vercel = vercelRequestContext(context);
  return {
    waitUntil(promise) {
      const task = Promise.resolve(promise).catch((error: unknown) => {
        console.error('[void] A waitUntil task failed:', error);
      });
      vercel?.waitUntil?.(task);
    },
    passThroughOnException() {},
    props: {},
  };
}

function sameSecret(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(actual);
  const b = encoder.encode(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type VercelHandlerOptions = Readonly<{
  /** The generated route table. */
  app: FetchApp;
  /** The route table's `scheduled` export, which runs the jobs for one cron expression. */
  scheduled: (
    controller: ScheduledController,
    env: unknown,
    ctx: ExecutionContextLike,
  ) => Promise<void>;
  /** The route table's prerender path discovery. */
  collectPrerenderPaths: (request: Request) => Promise<Array<string>>;
  /** Directory of client build files the function can read. */
  clientRoot: string;
  /** Vite's assets directory, without slashes. */
  assetsDir: string;
  /** Validates the environment schema once, when the app has one. */
  validateEnv?: () => Promise<unknown>;
  /** The environment to read `CRON_SECRET` from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}>;

/** Run the cron jobs Vercel Cron Jobs schedules, after checking `CRON_SECRET`. */
async function runCron(
  request: Request,
  options: VercelHandlerOptions,
  env: unknown,
  ctx: ExecutionContextLike,
): Promise<Response> {
  const secret = (options.env ?? process.env).CRON_SECRET;
  if (!secret) {
    console.error(
      '[void] Cron job not run: set a CRON_SECRET environment variable in your Vercel project. Vercel sends it with each cron invocation.',
    );
    return new Response('CRON_SECRET is not set', { status: 500 });
  }
  const authorization = request.headers.get('authorization') ?? '';
  if (!sameSecret(authorization, `Bearer ${secret}`)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const cron = request.headers.get('x-vercel-cron-schedule');
  if (!cron) {
    return new Response('Missing x-vercel-cron-schedule', { status: 400 });
  }
  try {
    await options.scheduled(
      { cron, scheduledTime: Date.now(), type: 'scheduled', noRetry() {} },
      env,
      ctx,
    );
  } catch (error) {
    console.error(`[void] Cron jobs for "${cron}" failed:`, error);
    return Response.json({ ok: false }, { status: 500 });
  }
  return Response.json({ ok: true });
}

/**
 * The Vercel Function handler. Vercel calls `fetch(request, context)`; the build's
 * prerender runner calls it with `{ __VOID_PRERENDER: "1" }` instead of a context.
 */
export function createVercelHandler(options: VercelHandlerOptions): {
  fetch(request: Request, context?: unknown): Promise<Response>;
} {
  const assets = createFileAssets(options.clientRoot);
  const assetsPrefix = `/${options.assetsDir}/`;
  return {
    async fetch(request, context) {
      const url = new URL(request.url);
      const discovery =
        request.method === 'POST' &&
        url.pathname === '/__void/prerender-paths' &&
        (context as { __VOID_PRERENDER?: unknown } | undefined)?.__VOID_PRERENDER === '1';
      if (discovery) {
        return Response.json({ paths: await options.collectPrerenderPaths(request) });
      }
      if (url.pathname === '/__void/prerender-paths' && request.method === 'POST') {
        return notFound();
      }
      if (options.validateEnv) {
        await options.validateEnv();
      }
      const env = { ASSETS: assets };
      const ctx = createExecutionContext(context);
      if (url.pathname === VERCEL_CRON_PATH && request.method === 'GET') {
        return runCron(request, options, env, ctx);
      }
      // Hashed files skip the app, as on the Node target. On Vercel the CDN
      // answers these first, so this matters for `vite preview`.
      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        url.pathname.startsWith(assetsPrefix)
      ) {
        const asset = await assets.fetch(request);
        if (asset.status !== 404) {
          return asset;
        }
      }
      return options.app.fetch(request, env, ctx);
    },
  };
}
