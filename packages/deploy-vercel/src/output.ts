import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { nodeFileTrace } from '@vercel/nft';
import { dirname, isAbsolute, join, relative, resolve } from 'pathslash';
import { VERCEL_FUNCTION_NAME, type VercelConfig } from './config.ts';
import type { VercelRuntime } from './runtime.ts';

/** Client build files that are build metadata or Void routing config, not public files. */
function isStaticExcluded(relativePath: string): boolean {
  return (
    relativePath === '.vite' ||
    relativePath.startsWith('.vite/') ||
    relativePath === '_headers' ||
    relativePath === '_redirects'
  );
}

function walk(dir: string, base: string, files: Array<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(base, path);
    if (isStaticExcluded(rel)) {
      continue;
    }
    if (entry.isDirectory()) {
      walk(path, base, files);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push('/' + rel);
    }
  }
}

/** URL paths of the public files in a client build, such as `/about.html`. */
export function listStaticFiles(clientDir: string): Array<string> {
  if (!existsSync(clientDir)) {
    return [];
  }
  const files: Array<string> = [];
  walk(clientDir, clientDir, files);
  return files.sort();
}

export type VercelFunctionOptions = Readonly<{
  /** Absolute path of the built server entry; its default export has `fetch`. */
  entry: string;
  /** Absolute server build directory, copied whole. */
  serverDir: string;
  /** Absolute client build directory, when the app has one. */
  clientDir?: string;
  /**
   * Client files the function reads, relative to `clientDir`. They keep their
   * place relative to `serverDir`, so the server build finds them as it does locally.
   */
  clientFiles: ReadonlyArray<string>;
  runtime: VercelRuntime;
  regions?: ReadonlyArray<string>;
  maxDuration?: number | 'max';
}>;

export type WriteVercelOutputOptions = Readonly<{
  /** The output directory, normally `<root>/.vercel/output`. Replaced on every write. */
  outputDir: string;
  /** Client build directory whose public files become `static/`. */
  clientDir?: string;
  config: VercelConfig;
  function?: VercelFunctionOptions;
}>;

function commonDirectory(paths: ReadonlyArray<string>): string {
  let common = dirname(paths[0]!);
  for (const path of paths) {
    while (path !== common && !path.startsWith(common.endsWith('/') ? common : `${common}/`)) {
      const parent = dirname(common);
      if (parent === common) {
        return common;
      }
      common = parent;
    }
  }
  return common;
}

/** Copy one traced file, recreating a symlink when its target is also inside the function. */
function copyTracedFile(source: string, target: string, root: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    const link = readlinkSync(source);
    const linked = isAbsolute(link) ? link : resolve(dirname(source), link);
    if (linked === root || linked.startsWith(`${root}/`)) {
      // pnpm links packages into place; keep the link so resolution still works.
      rmSync(target, { force: true });
      symlinkSync(relative(dirname(source), linked), target);
      return;
    }
    copyFileSync(realpathSync(source), target);
    return;
  }
  if (stat.isFile()) {
    copyFileSync(source, target);
  }
}

async function writeFunction(funcDir: string, options: VercelFunctionOptions): Promise<void> {
  // Real paths, so the trace does not report symlinked parents such as macOS `/var`.
  const entry = realpathSync(options.entry);
  const serverDir = realpathSync(options.serverDir);
  const clientDir =
    options.clientDir && existsSync(options.clientDir)
      ? realpathSync(options.clientDir)
      : undefined;
  // The server build is bundled; trace what it still imports (native addons and
  // packages left external) so the function does not need the app's node_modules.
  const trace = await nodeFileTrace([entry], { base: '/', processCwd: dirname(entry) });
  const inside = (dir: string | undefined, file: string) =>
    dir !== undefined && (file === dir || file.startsWith(`${dir}/`));
  // The trace reads the server's `new URL('../client/', import.meta.url)` as the
  // whole client build; the CDN serves that, so only `clientFiles` go in.
  const traced = [...trace.fileList]
    .map((file) => resolve('/', file))
    .filter((file) => !inside(serverDir, file) && !inside(clientDir, file))
    .filter((file) => {
      const stat = lstatSync(file, { throwIfNoEntry: false });
      return stat !== undefined && (stat.isFile() || stat.isSymbolicLink());
    });
  const clientFiles = clientDir
    ? options.clientFiles.map((file) => join(clientDir, file)).filter((file) => existsSync(file))
    : [];
  const root = commonDirectory([entry, serverDir, ...clientFiles, ...traced]);

  mkdirSync(funcDir, { recursive: true });
  cpSync(serverDir, join(funcDir, relative(root, serverDir)), { recursive: true });
  for (const file of [...clientFiles, ...traced]) {
    copyTracedFile(file, join(funcDir, relative(root, file)), root);
  }
  // The server build is ESM. These win over any package.json the trace copied.
  writeFileSync(join(funcDir, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(funcDir, relative(root, serverDir), 'package.json'), '{ "type": "module" }\n');
  const vcConfig = {
    runtime: options.runtime,
    handler: relative(root, entry),
    launcherType: 'Nodejs',
    shouldAddHelpers: false,
    supportsResponseStreaming: true,
    ...(options.maxDuration !== undefined && { maxDuration: options.maxDuration }),
    ...(options.regions && options.regions.length > 0 && { regions: [...options.regions] }),
  };
  writeFileSync(join(funcDir, '.vc-config.json'), JSON.stringify(vcConfig, null, 2) + '\n');
}

/** Write a Build Output API v3 directory. */
export async function writeVercelOutput(options: WriteVercelOutputOptions): Promise<void> {
  const outputDir = resolve(options.outputDir);
  rmSync(outputDir, { recursive: true, force: true });
  const staticDir = join(outputDir, 'static');
  mkdirSync(staticDir, { recursive: true });
  if (options.clientDir && existsSync(options.clientDir)) {
    const clientDir = resolve(options.clientDir);
    cpSync(clientDir, staticDir, {
      recursive: true,
      filter: (source) => source === clientDir || !isStaticExcluded(relative(clientDir, source)),
    });
  }
  if (options.function) {
    await writeFunction(
      join(outputDir, 'functions', `${VERCEL_FUNCTION_NAME}.func`),
      options.function,
    );
  }
  writeFileSync(join(outputDir, 'config.json'), JSON.stringify(options.config, null, 2) + '\n');
}
