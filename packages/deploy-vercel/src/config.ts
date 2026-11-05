import type { HeaderRule } from '@void/deploy-core';
import { matchLiteralPattern, patternRegexSource } from '@void/edge';
import { vercelCronError } from './cron.ts';

/** The function that serves every request the CDN does not answer. */
export const VERCEL_FUNCTION_NAME = '__void';
/** The path Vercel Cron Jobs call. */
export const VERCEL_CRON_PATH = '/__void/cron';

const FUNCTION_PATH = `/${VERCEL_FUNCTION_NAME}`;
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
// As on Cloudflare, header rules cannot replace these on content-hashed files.
const HASHED_FILE_PROTECTED_HEADERS = new Set([
  'cache-control',
  'content-type',
  'content-encoding',
  'content-length',
  'content-range',
  'accept-ranges',
  'transfer-encoding',
]);
const REDIRECT_METHODS = ['GET', 'HEAD'];
// Long alternations are split across routes to keep each `src` small.
const MAX_SOURCE_LENGTH = 4000;
// Workers Assets' `auto-trailing-slash` redirects clean URLs with 307.
const HTML_REDIRECT_STATUS = 307;
/** `/404.html`, `/500.html`: error pages the function reads by name. */
const ERROR_PAGE = /^\/\d{3}\.html$/;

export type VercelHasCondition = { type: 'host'; value: string };

export type VercelSourceRoute = {
  src: string;
  dest?: string;
  status?: number;
  headers?: Record<string, string>;
  continue?: boolean;
  check?: boolean;
  methods?: Array<string>;
  has?: Array<VercelHasCondition>;
};

export type VercelRoute = { handle: 'filesystem' | 'hit' } | VercelSourceRoute;

/** `.vercel/output/config.json` (Build Output API v3). */
export type VercelConfig = {
  version: 3;
  routes: Array<VercelRoute>;
  overrides?: Record<string, { path: string }>;
  crons?: Array<{ path: string; schedule: string }>;
  framework?: { version: string };
};

/** A redirect, rewrite or fallback rule as Void merges them (first match wins). */
export type VercelRoutingRule = Readonly<{
  source: string;
  destination: string;
  status: number;
  host?: string;
}>;

export type CreateVercelConfigInput = Readonly<{
  /** Redirects (3xx) and rewrites (200), in Void's merged order. */
  redirectRules: ReadonlyArray<VercelRoutingRule>;
  /** Fallbacks: rewrites that apply only when nothing else answers. */
  fallbackRules: ReadonlyArray<VercelRoutingRule>;
  /** Header rules in Void's merged order (last match wins). */
  headerRules: ReadonlyArray<HeaderRule>;
  /** URL paths of every file in the static directory, such as `/about.html`. */
  staticFiles: ReadonlyArray<string>;
  /** URL paths of content-hashed files that can be cached forever. */
  immutableFiles: ReadonlyArray<string>;
  /** Vite's assets directory, without slashes. */
  assetsDir: string;
  /** Answer missing files under the assets directory with 404 instead of the function. */
  guardMissingAssets: boolean;
  /** Whether the output has a server function. */
  hasFunction: boolean;
  /** Cron expressions to register with Vercel Cron Jobs. */
  cronSchedules: ReadonlyArray<string>;
  /** Void's version, shown by Vercel. */
  frameworkVersion?: string;
}>;

export type CreateVercelConfigResult = Readonly<{
  config: VercelConfig;
  /** Static files the function reads: rewrite and fallback destinations and error pages. */
  functionStaticFiles: ReadonlyArray<string>;
  /** Rules Vercel cannot apply as written. The build should fail on these. */
  errors: ReadonlyArray<string>;
}>;

type ParsedRule = Readonly<{
  rule: VercelRoutingRule;
  src: string;
  has: Array<VercelHasCondition> | undefined;
  /** Why the edge cannot apply the destination exactly as Void does. */
  issue: 'query' | 'unsafe' | undefined;
  dest: string;
}>;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRule(rule: VercelRoutingRule): ParsedRule | undefined {
  let src: string;
  try {
    src = patternRegexSource(rule.source);
  } catch {
    // Void skips a malformed rule at runtime, so the edge skips it too.
    return undefined;
  }
  const names = new Set<string>();
  const multiSegment = new Set<string>();
  for (const match of src.matchAll(/\(\?<([A-Za-z0-9_]+)>(\[\^\/\]\+|\.\*)\)/g)) {
    names.add(match[1]!);
    if (match[2] === '.*') {
      multiSegment.add(match[1]!);
    }
  }
  const destination = rule.destination;
  const leading = /^[/\\]:([A-Za-z0-9_]+)/.exec(destination)?.[1];
  // Vercel substitutes `$name`, so a literal `$` cannot be written. A capture that
  // can start with `/` right after the leading slash would make `//host`, which
  // Void collapses to one slash at runtime and Vercel would treat as another site.
  const unsafe = destination.includes('$') || (leading !== undefined && multiSegment.has(leading));
  const issue = unsafe
    ? 'unsafe'
    : destination.includes('?') || destination.includes('#')
      ? 'query'
      : undefined;
  const dest = destination.replace(/:([A-Za-z0-9_]+)\*?/g, (whole, name: string) =>
    names.has(name) ? `$${name}` : whole,
  );
  return {
    rule,
    src,
    has: rule.host ? [{ type: 'host', value: rule.host }] : undefined,
    issue,
    dest,
  };
}

function withHas(route: VercelSourceRoute, has: ParsedRule['has']): VercelSourceRoute {
  return has ? { ...route, has } : route;
}

/** One route per group of paths, each `src` an anchored alternation. */
function alternationRoutes(
  paths: ReadonlyArray<string>,
  wrap: (alternation: string) => string,
  route: Omit<VercelSourceRoute, 'src'>,
): Array<VercelSourceRoute> {
  const routes: Array<VercelSourceRoute> = [];
  let group: Array<string> = [];
  let length = 0;
  const flush = () => {
    if (group.length > 0) {
      routes.push({ src: wrap(group.join('|')), ...route });
      group = [];
      length = 0;
    }
  };
  for (const path of paths) {
    const escaped = escapeRegex(path);
    if (length + escaped.length > MAX_SOURCE_LENGTH) {
      flush();
    }
    group.push(escaped);
    length += escaped.length + 1;
  }
  flush();
  return routes;
}

type StaticLayout = {
  overrides: Record<string, { path: string }>;
  /** Canonical request path and every path that serves the file. */
  served: Map<string, { canonical: string; aliases: Array<string> }>;
  trailingSlashOff: Array<string>;
  htmlOff: Array<string>;
  trailingSlashOn: Array<string>;
  indexOff: Array<string>;
};

/** Clean URLs as Workers Assets' default `auto-trailing-slash` serves them. */
function layoutStaticFiles(staticFiles: ReadonlyArray<string>): StaticLayout {
  const files = new Set(staticFiles);
  const layout: StaticLayout = {
    overrides: {},
    served: new Map(),
    trailingSlashOff: [],
    htmlOff: [],
    trailingSlashOn: [],
    indexOff: [],
  };
  for (const file of [...staticFiles].sort()) {
    if (file.endsWith('/index.html')) {
      const dir = file.slice(0, -'index.html'.length);
      if (dir === '/') {
        layout.served.set(file, { canonical: '/', aliases: ['/', file] });
        layout.indexOff.push('');
      } else {
        const bare = dir.slice(0, -1);
        layout.served.set(file, { canonical: dir, aliases: [dir, bare, file] });
        layout.trailingSlashOn.push(bare.slice(1));
        layout.indexOff.push(bare.slice(1));
      }
    } else if (file.endsWith('.html') && !ERROR_PAGE.test(file)) {
      const clean = file.slice(0, -'.html'.length);
      if (files.has(clean) || files.has(`${clean}/index.html`)) {
        layout.served.set(file, { canonical: file, aliases: [file] });
        continue;
      }
      layout.overrides[file.slice(1)] = { path: clean.slice(1) };
      layout.served.set(file, { canonical: clean, aliases: [clean] });
      layout.trailingSlashOff.push(clean.slice(1));
      layout.htmlOff.push(clean.slice(1));
    } else {
      layout.served.set(file, { canonical: file, aliases: [file] });
    }
  }
  return layout;
}

function htmlRedirectRoutes(layout: StaticLayout): Array<VercelSourceRoute> {
  const redirect = (location: string) => ({
    status: HTML_REDIRECT_STATUS,
    headers: { Location: location },
  });
  const named = (suffix: string) => (alternation: string) => `^/(?<path>${alternation})${suffix}$`;
  const rootIndex = layout.indexOff.includes('');
  const dirs = layout.indexOff.filter(Boolean);
  return [
    ...alternationRoutes(layout.trailingSlashOff, named('/'), redirect('/$path')),
    ...alternationRoutes(layout.htmlOff, named('\\.html'), redirect('/$path')),
    ...alternationRoutes(layout.trailingSlashOn, named(''), redirect('/$path/')),
    ...alternationRoutes(dirs, named('/index\\.html'), redirect('/$path/')),
    ...(rootIndex ? [{ src: '^/index\\.html$', ...redirect('/') }] : []),
  ];
}

/** Header routes for static files, computed with Void's own merge (last match wins). */
function staticHeaderRoutes(
  layout: StaticLayout,
  headerRules: ReadonlyArray<HeaderRule>,
  immutableFiles: ReadonlySet<string>,
): Array<VercelSourceRoute> {
  const groups = new Map<string, { headers: Record<string, string>; paths: Array<string> }>();
  for (const [file, { canonical, aliases }] of layout.served) {
    const headers = new Map<string, string>();
    for (const rule of headerRules) {
      if (matchLiteralPattern(rule.pattern, canonical)) {
        for (const [name, value] of rule.headers) {
          headers.set(name.toLowerCase(), value);
        }
      }
    }
    if (immutableFiles.has(file)) {
      for (const name of HASHED_FILE_PROTECTED_HEADERS) {
        headers.delete(name);
      }
      headers.set('cache-control', IMMUTABLE_CACHE_CONTROL);
    }
    if (headers.size === 0) {
      continue;
    }
    const entries = [...headers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const key = JSON.stringify(entries);
    let group = groups.get(key);
    if (!group) {
      group = { headers: Object.fromEntries(entries), paths: [] };
      groups.set(key, group);
    }
    group.paths.push(...aliases);
  }
  const routes: Array<VercelSourceRoute> = [];
  for (const { headers, paths } of groups.values()) {
    routes.push(
      ...alternationRoutes(paths, (alternation) => `^(?:${alternation})$`, {
        headers,
        continue: true,
      }),
    );
  }
  return routes;
}

/** Static files whose path a rewrite or fallback destination can resolve to. */
function destinationFiles(
  rules: ReadonlyArray<VercelRoutingRule>,
  staticFiles: ReadonlyArray<string>,
): Array<string> {
  const patterns = rules.map((rule) =>
    rule.destination
      .replace(/[?#].*$/, '')
      .replace(/:[A-Za-z0-9_]+\*?/g, '*')
      .replace(/^https?:\/\/[^/]+/, ''),
  );
  return staticFiles.filter((file) =>
    patterns.some((pattern) => matchLiteralPattern(pattern, file)),
  );
}

function describe(kind: string, rule: VercelRoutingRule): string {
  return `${kind} "${rule.source}" -> "${rule.destination}"`;
}

/**
 * Build `.vercel/output/config.json` from Void's routing rules and build output.
 *
 * With a function, a rule the edge cannot apply exactly sends its requests to the
 * function, which applies every rule itself: the function sees the original URL
 * after an edge rewrite. Redirects run at the edge for GET and HEAD only, so the
 * function keeps page-action redirects. Fallbacks always run in the function.
 * Static output has no function, so every rule must run at the edge.
 */
export function createVercelConfig(input: CreateVercelConfigInput): CreateVercelConfigResult {
  const errors: Array<string> = [];
  const routes: Array<VercelRoute> = [];
  const toFunction = (parsed: ParsedRule): VercelSourceRoute =>
    withHas({ src: parsed.src, dest: FUNCTION_PATH }, parsed.has);

  for (const rule of input.redirectRules) {
    const parsed = parseRule(rule);
    if (!parsed) {
      continue;
    }
    const rewrite = rule.status === 200;
    if (input.hasFunction && parsed.issue) {
      routes.push(toFunction(parsed));
      continue;
    }
    if (parsed.issue === 'unsafe') {
      errors.push(
        `${describe(rewrite ? 'rewrite' : 'redirect', rule)} can't run on Vercel without a server: ` +
          'its destination contains "$" or starts with a multi-segment parameter.',
      );
      continue;
    }
    if (rewrite) {
      routes.push(withHas({ src: parsed.src, dest: parsed.dest }, parsed.has));
      continue;
    }
    const redirect: VercelSourceRoute = {
      src: parsed.src,
      status: rule.status,
      headers: { Location: parsed.dest },
    };
    if (input.hasFunction) {
      routes.push(withHas({ ...redirect, methods: REDIRECT_METHODS }, parsed.has));
      routes.push(toFunction(parsed));
    } else {
      routes.push(withHas(redirect, parsed.has));
    }
  }

  const layout = layoutStaticFiles(input.staticFiles);
  routes.push(...htmlRedirectRoutes(layout));
  routes.push({ handle: 'filesystem' });

  if (input.guardMissingAssets) {
    routes.push({
      src: `^/${escapeRegex(input.assetsDir)}/.+$`,
      status: 404,
      headers: { 'cache-control': 'no-store' },
    });
  }

  if (input.hasFunction) {
    routes.push({ src: '^/.*$', dest: FUNCTION_PATH });
  } else {
    for (const rule of input.fallbackRules) {
      const parsed = parseRule(rule);
      if (!parsed) {
        continue;
      }
      if (parsed.issue === 'unsafe') {
        errors.push(
          `${describe('fallback', rule)} can't run on Vercel without a server: ` +
            'its destination contains "$" or starts with a multi-segment parameter.',
        );
        continue;
      }
      routes.push(withHas({ src: parsed.src, dest: parsed.dest, check: true }, parsed.has));
    }
    if (input.staticFiles.includes('/404.html')) {
      routes.push({ src: '^/.*$', dest: '/404.html', status: 404, check: true });
    }
  }

  const headerRoutes = staticHeaderRoutes(layout, input.headerRules, new Set(input.immutableFiles));
  if (headerRoutes.length > 0) {
    routes.push({ handle: 'hit' }, ...headerRoutes);
  }

  const schedules = [...new Set(input.cronSchedules)];
  for (const schedule of schedules) {
    const error = vercelCronError(schedule);
    if (error) {
      errors.push(`cron "${schedule}" isn't supported by Vercel Cron Jobs: ${error}.`);
    }
  }
  if (schedules.length > 0 && !input.hasFunction) {
    errors.push('Cron jobs need a server function, but this build has none.');
  }

  const config: VercelConfig = {
    version: 3,
    routes,
    ...(Object.keys(layout.overrides).length > 0 && { overrides: layout.overrides }),
    ...(schedules.length > 0 && {
      crons: schedules.map((schedule) => ({ path: VERCEL_CRON_PATH, schedule })),
    }),
    ...(input.frameworkVersion && { framework: { version: input.frameworkVersion } }),
  };

  const rewrites = input.redirectRules.filter((rule) => rule.status === 200);
  const functionStaticFiles = input.hasFunction
    ? [
        ...new Set([
          ...destinationFiles([...rewrites, ...input.fallbackRules], input.staticFiles),
          ...input.staticFiles.filter((file) => ERROR_PAGE.test(file)),
        ]),
      ].sort()
    : [];

  return { config, functionStaticFiles, errors };
}
