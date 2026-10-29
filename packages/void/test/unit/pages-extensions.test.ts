import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigEnv, Plugin } from 'vite';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { prepareProject } from '../../src/codegen/prepare.ts';
import { loadPageExtensions, resolvePageExtensions } from '../../src/pages/extensions.ts';
import { scanPages } from '../../src/pages/scan.ts';

const roots: Array<string> = [];
const development: ConfigEnv = { command: 'serve', mode: 'development' };
const production: ConfigEnv = { command: 'build', mode: 'production' };

function format(name: string, extensions: ReadonlyArray<string>): Plugin {
  return { name, api: { voidPages: { extensions } } };
}

function project(source?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'void-page-extensions-'));
  roots.push(root);
  if (source) {
    writeFileSync(join(root, 'vite.config.mjs'), source);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plugin-owned page extensions', () => {
  it('has no built-in component or Markdown extension set', async () => {
    expect(await resolvePageExtensions([{ name: 'unrelated' }])).toEqual([]);
  });

  it('combines nested and asynchronous plugins and removes duplicate extensions', async () => {
    const extensions = await resolvePageExtensions([
      false,
      [format('components', ['jsx', 'tsx']), Promise.resolve([format('markdown', ['md', 'tsx'])])],
      undefined,
    ]);
    expect(extensions).toEqual(['jsx', 'md', 'tsx']);
  });

  it('includes the adapter declaration when directly constructing its Pages plugin', async () => {
    expect(
      await resolvePageExtensions([format('markdown', ['md'])], { extensions: ['vue'] }),
    ).toEqual(['md', 'vue']);
  });

  it('honors plugin apply conditions for both commands', async () => {
    const plugins: Array<Plugin> = [
      { ...format('build-format', ['buildfmt']), apply: 'build' },
      {
        ...format('dev-format', ['devfmt']),
        apply(config, environment) {
          return config.mode === 'development' && environment.command === 'serve';
        },
      },
    ];
    expect(await resolvePageExtensions(plugins, { environment: development })).toEqual(['devfmt']);
    expect(await resolvePageExtensions(plugins, { environment: production })).toEqual(['buildfmt']);
  });

  it('does not evaluate apply predicates for plugins without page formats', async () => {
    let calls = 0;
    const extensions = await resolvePageExtensions(
      [
        {
          name: 'unrelated',
          apply() {
            calls++;
            return true;
          },
        },
      ],
      { environment: production },
    );
    expect(extensions).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('CLI page extension discovery', () => {
  it('returns no extensions when there is no Vite config', async () => {
    expect(await loadPageExtensions(project())).toEqual([]);
  });

  it('evaluates async config functions without running lifecycle hooks', async () => {
    const root = project(`
      export default async function config({ command }) {
        return {
          plugins: [Promise.resolve([{
            name: 'custom-format',
            api: { voidPages: { extensions: [command === 'serve' ? 'devfmt' : 'prodfmt'] } },
            config() { throw new Error('config hook must not run'); },
            configResolved() { throw new Error('configResolved hook must not run'); },
            buildStart() { throw new Error('buildStart hook must not run'); },
            configureServer() { throw new Error('configureServer hook must not run'); },
          }])],
        };
      }
    `);
    expect(await loadPageExtensions(root, 'dev')).toEqual(['devfmt']);
    expect(await loadPageExtensions(root, 'prod')).toEqual(['prodfmt']);
  });

  it('does not infer extensions from package dependencies or filenames', async () => {
    const root = project('export default { plugins: [] };');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@void/md': '*' } }),
    );
    writeFileSync(join(root, 'about.vue'), '<template>About</template>');
    expect(await loadPageExtensions(root)).toEqual([]);
  });

  it('uses plugin declarations for scanning and generated route types', async () => {
    const root = project(`export default {
      plugins: [{ name: 'react-pages', api: { voidPages: { extensions: ['tsx'] } } }],
    };`);
    mkdirSync(join(root, 'pages'));
    writeFileSync(join(root, 'pages/about.tsx'), 'export default () => null;');
    writeFileSync(
      join(root, 'pages/about.server.ts'),
      'export const action = () => ({ ok: true });',
    );
    writeFileSync(join(root, 'pages/about.vue'), '<template>About</template>');
    writeFileSync(join(root, 'pages/foreign.vue'), '<template>Foreign</template>');
    writeFileSync(join(root, 'pages/docs.md'), '# Docs');

    expect((await scanPages(root)).pages.map((page) => page.componentPath)).toEqual(['about.tsx']);
    await prepareProject(root);
    const types = readFileSync(join(root, '.void/routes.d.ts'), 'utf8');
    expect(types).toContain('/about');
    expect(types).not.toContain('/foreign');
    expect(types).not.toContain('/docs');
  });

  it('accepts an extension supplied by a custom format plugin', async () => {
    const root = project(`export default {
      plugins: [{ name: 'custom-format', api: { voidPages: { extensions: ['example'] } } }],
    };`);
    mkdirSync(join(root, 'pages'));
    writeFileSync(join(root, 'pages/home.dev.example'), 'Example page');
    writeFileSync(join(root, 'pages/home.prod.example'), 'Example page');
    expect(
      (await scanPages(root, { environment: 'dev' })).pages.map((page) => page.componentPath),
    ).toEqual(['home.dev.example']);
    expect(
      (await scanPages(root, { environment: 'prod' })).pages.map((page) => page.componentPath),
    ).toEqual(['home.prod.example']);
  });

  it('keeps conditional plugin formats separate while preparing both environments', async () => {
    const root = project(`export default ({ command }) => ({
      plugins: [{ name: 'conditional-format', api: {
        voidPages: { extensions: [command === 'serve' ? 'tsx' : 'vue'] },
      } }],
    });`);
    mkdirSync(join(root, 'pages'));
    writeFileSync(join(root, 'pages/index.tsx'), 'export default () => null;');
    writeFileSync(join(root, 'pages/index.vue'), '<template>Home</template>');
    const scan = await scanPages(root);
    expect(scan.pages.map((page) => [page.componentPath, page.env])).toEqual([
      ['index.tsx', 'dev'],
      ['index.vue', 'prod'],
    ]);
  });

  it('uses the configured mode when checking a format plugin’s apply predicate', async () => {
    const root = project(`export default {
      mode: 'custom',
      plugins: [{
        name: 'custom-mode-format',
        api: { voidPages: { extensions: ['custom'] } },
        apply(config) { return config.mode === 'custom'; },
      }],
    };`);
    expect(await loadPageExtensions(root, 'prod')).toEqual(['custom']);
  });

  it('prepares a fresh TypeScript Pages app before its generated tsconfig exists', async () => {
    const root = project();
    writeFileSync(
      join(root, 'vite.config.ts'),
      `export default {
      plugins: [{ name: 'page-format', api: { voidPages: { extensions: ['tsx'] } } }],
    };`,
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ extends: './.void/tsconfig.json' }),
    );
    mkdirSync(join(root, 'pages'));
    writeFileSync(join(root, 'pages/index.tsx'), 'export default () => null;');
    await prepareProject(root);
    expect(readFileSync(join(root, '.void/tsconfig.json'), 'utf8')).toContain('routes.d.ts');
  });
});
