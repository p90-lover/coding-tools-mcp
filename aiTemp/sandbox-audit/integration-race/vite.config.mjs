import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
const repo=process.cwd();
export default defineConfig({
  root:path.join(repo,'aiTemp/sandbox-audit/integration-race'),
  plugins:[svelte({configFile:false})],
  resolve:{alias:{$lib:path.join(repo,'src/lib')}},
  server:{host:'127.0.0.1',port:1431,strictPort:true,fs:{allow:[repo]}},
  cacheDir:path.join(repo,'aiTemp/sandbox-audit/vite-cache')
});
