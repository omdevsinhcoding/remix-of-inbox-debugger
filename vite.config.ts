import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const deployVersion = (
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.VITE_BUILD_ID ||
    'local'
  )
    .slice(0, 8)
    .replace(/[^a-zA-Z0-9_-]/g, '');

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
    },
    build: {
      target: 'es2020',
      cssCodeSplit: true,
      sourcemap: false,
      rollupOptions: {
        output: {
          entryFileNames: `assets/[name]-${deployVersion}-[hash].js`,
          chunkFileNames: `assets/[name]-${deployVersion}-[hash].js`,
          assetFileNames: `assets/[name]-${deployVersion}-[hash][extname]`,
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('react-router')) return 'vendor-router';
            if (id.includes('react-dom') || /[\\/]react[\\/]/.test(id) || id.includes('scheduler')) return 'vendor-react';
            if (id.includes('@supabase')) return 'vendor-supabase';
            if (id.includes('motion') || id.includes('framer-motion')) return 'vendor-motion';
            if (id.includes('lucide-react')) return 'vendor-icons';
            if (id.includes('sonner')) return 'vendor-toast';
            if (id.includes('qrcode.react') || id.includes('react-google-recaptcha')) return 'vendor-auth';
            return 'vendor';
          },
        },
      },
    },
  };
});
