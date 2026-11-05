import { existsSync, readFileSync } from 'node:fs';
import {
  createVercelConfig,
  listStaticFiles,
  resolveVercelRuntime,
  writeVercelOutput,
} from '@void/deploy-vercel';
import { join } from 'pathslash';
import { patternCanReachUnder } from './asset-worker-bypass.ts';
import { getPackageDir } from './cli/agents.ts';
import type { VercelTargetConfig } from './config.ts';
import { voidLog } from './log.ts';
import type { RoutingHeaderRule, RoutingRule } from './runtime/routing.ts';

export type VercelBuildOutputInput = Readonly<{
  root: string;
  /** Vite's assets directory, without slashes. */
  assetsDir: string;
  /** Merged redirects and rewrites, in Void's order. */
  redirectRules: ReadonlyArray<RoutingRule>;
  fallbackRules: ReadonlyArray<RoutingRule>;
  headerRules: ReadonlyArray<RoutingHeaderRule>;
  /** Content-hashed files stamped into the client manifest, relative to the client root. */
  immutableFiles: ReadonlyArray<string>;
  /** Route and page patterns, to tell whether a request under the assets directory can reach the app. */
  routePatterns: ReadonlyArray<string>;
  cronSchedules: ReadonlyArray<string>;
  /** Whether any request needs the server: routes, unprerendered pages, actions or crons. */
  hasServer: boolean;
  vercel?: VercelTargetConfig;
}>;

function voidVersion(): string | undefined {
  try {
    return (
      JSON.parse(readFileSync(join(getPackageDir(), 'package.json'), 'utf8')) as {
        version?: string;
      }
    ).version;
  } catch {
    return undefined;
  }
}

function toVercelRule({ source, destination, status, host }: RoutingRule) {
  return { source, destination, status, ...(host && { host }) };
}

/** Write `.vercel/output` from a finished `target: 'vercel'` build in `dist/`. */
export async function writeVercelBuildOutput(input: VercelBuildOutputInput): Promise<void> {
  const clientDir = join(input.root, 'dist', 'client');
  const ssrDir = join(input.root, 'dist', 'ssr');
  const hasClient = existsSync(clientDir);
  const staticFiles = hasClient ? listStaticFiles(clientDir) : [];
  const { config, functionStaticFiles, errors } = createVercelConfig({
    redirectRules: input.redirectRules.map(toVercelRule),
    fallbackRules: input.fallbackRules.map(toVercelRule),
    headerRules: input.headerRules,
    staticFiles,
    immutableFiles: input.immutableFiles.map((file) => `/${file}`),
    assetsDir: input.assetsDir,
    guardMissingAssets:
      hasClient &&
      !input.routePatterns.some((pattern) => patternCanReachUnder(pattern, input.assetsDir)),
    hasFunction: input.hasServer,
    cronSchedules: input.cronSchedules,
    frameworkVersion: voidVersion(),
  });
  if (errors.length > 0) {
    throw new Error(
      `vercel: This app can't be built for Vercel:\n${errors.map((error) => `  - ${error}`).join('\n')}`,
    );
  }
  const outputDir = join(input.root, '.vercel', 'output');
  await writeVercelOutput({
    outputDir,
    clientDir: hasClient ? clientDir : undefined,
    config,
    function: input.hasServer
      ? {
          entry: join(ssrDir, 'app.js'),
          serverDir: ssrDir,
          clientDir: hasClient ? clientDir : undefined,
          clientFiles: ['.vite/manifest.json', ...functionStaticFiles.map((file) => file.slice(1))],
          runtime: resolveVercelRuntime(process.version, input.vercel?.runtime),
          regions: input.vercel?.regions,
          maxDuration: input.vercel?.maxDuration,
        }
      : undefined,
  });
  voidLog(`Vercel output written to ${join('.vercel', 'output')}`);
  if (input.hasServer && input.cronSchedules.length > 0) {
    voidLog(
      'Cron jobs run on Vercel only when the project has a CRON_SECRET environment variable.',
    );
  }
}
