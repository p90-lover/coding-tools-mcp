import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
const root=process.cwd();
export default defineConfig({root:path.join(root,'aiTemp/tool-exposure/browser'),plugins:[svelte({configFile:false})],resolve:{alias:{$lib:path.join(root,'src/lib')}},server:{host:'127.0.0.1',port:1429,strictPort:true,fs:{allow:[root]}},cacheDir:path.join(root,'aiTemp/tool-exposure/vite-cache')});
