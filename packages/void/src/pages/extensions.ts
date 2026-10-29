import type { ConfigEnv, PluginOption, UserConfig } from 'vite';

export type PagesPluginApi = {
  /** Bare file extensions, without a leading dot. */
  voidPages: { extensions: ReadonlyArray<string> };
};

/** Read extension declarations from the plugins enabled for this Vite configuration. */
export async function resolvePageExtensions(
  plugins: ReadonlyArray<PluginOption>,
  options: {
    config?: UserConfig;
    environment?: ConfigEnv;
    extensions?: ReadonlyArray<string>;
  } = {},
): Promise<Array<string>> {
  const { config, environment } = options;
  const extensions = new Set(options.extensions);

  async function collect(option: PluginOption): Promise<void> {
    const plugin = await option;
    if (Array.isArray(plugin)) {
      for (const child of plugin) {
        await collect(child);
      }
      return;
    }
    if (!plugin) {
      return;
    }
    const api = 'api' in plugin ? (plugin.api as Partial<PagesPluginApi> | undefined) : undefined;
    if (!api?.voidPages) {
      return;
    }
    if (environment && 'apply' in plugin && plugin.apply) {
      const enabled =
        typeof plugin.apply === 'function'
          ? plugin.apply({ ...config, mode: environment.mode }, environment)
          : plugin.apply === environment.command;
      if (!enabled) {
        return;
      }
    }
    for (const extension of api.voidPages.extensions) {
      extensions.add(extension);
    }
  }

  for (const plugin of plugins) {
    await collect(plugin);
  }
  return [...extensions].sort();
}

/** Evaluate plugin declarations for CLI analysis without running Vite lifecycle hooks. */
export async function loadPageExtensions(
  root: string,
  environment: 'dev' | 'prod' = 'prod',
): Promise<Array<string>> {
  const { loadConfigFromFile } = await import('vite');
  const configEnvironment: ConfigEnv = {
    command: environment === 'dev' ? 'serve' : 'build',
    mode: environment === 'dev' ? 'development' : 'production',
    isPreview: false,
  };
  const result = await loadConfigFromFile(configEnvironment, undefined, root);
  if (!result) {
    return [];
  }
  return resolvePageExtensions(result.config.plugins ?? [], {
    config: result.config,
    environment: { ...configEnvironment, mode: result.config.mode ?? configEnvironment.mode },
  });
}
