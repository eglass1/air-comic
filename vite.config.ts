import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const pwaDir = resolve(projectRoot, 'pwa');

/**
 * Emits the PWA companion files next to the single-file bundle.
 *
 * The application itself stays one self-contained docs/index.html that still
 * works from a file:// URL or any static host. The manifest, service worker and
 * icons are deliberately kept as separate same-origin files: a manifest in a
 * data: URL cannot define a scope, and a service worker cannot be registered
 * from one at all.
 *
 * Head tags are injected in the `post` phase so Vite's HTML asset pipeline never
 * sees them -- with assetsInlineLimit raised for the single-file build it would
 * otherwise try to inline the manifest and icons as data URLs.
 */
function aircomicPwa(): Plugin {
  let outDir = 'docs';
  let buildId = 'dev';

  return {
    name: 'aircomic-pwa',
    apply: 'build',

    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },

    transformIndexHtml: {
      order: 'post',
      handler: () => [
        {
          tag: 'link',
          attrs: { rel: 'manifest', href: './manifest.webmanifest' },
          injectTo: 'head' as const,
        },
        {
          tag: 'link',
          attrs: { rel: 'apple-touch-icon', sizes: '180x180', href: './icons/apple-touch-icon-180.png' },
          injectTo: 'head' as const,
        },
      ],
    },

    async closeBundle() {
      const iconDir = resolve(pwaDir, 'icons');
      const iconNames = (await readdir(iconDir)).sort();

      // The build id covers everything the worker precaches, so redeploying an
      // unchanged build does not churn the service worker, while any real
      // change guarantees new sw.js bytes and therefore an update check.
      const hash = createHash('sha256');
      hash.update(await readFile(resolve(outDir, 'index.html')));
      hash.update(await readFile(resolve(pwaDir, 'manifest.webmanifest')));
      for (const name of iconNames) {
        hash.update(await readFile(resolve(iconDir, name)));
      }
      buildId = hash.digest('hex').slice(0, 12);

      const serviceWorker = await readFile(resolve(pwaDir, 'sw.js'), 'utf8');
      await writeFile(
        resolve(outDir, 'sw.js'),
        serviceWorker.replace('__BUILD_ID__', buildId),
        'utf8'
      );

      await cp(resolve(pwaDir, 'manifest.webmanifest'), resolve(outDir, 'manifest.webmanifest'));
      await mkdir(resolve(outDir, 'icons'), { recursive: true });
      await cp(iconDir, resolve(outDir, 'icons'), { recursive: true });

      this.info(`PWA companion files emitted (build ${buildId})`);
    },
  };
}

export default defineConfig({
  plugins: [react(), viteSingleFile(), aircomicPwa()],
  build: {
    outDir: 'docs',
    target: 'esnext',
    copyPublicDir: false,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
