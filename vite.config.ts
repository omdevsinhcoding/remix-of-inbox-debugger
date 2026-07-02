import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const isProductionBuild = mode === 'production';

  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(isProductionBuild ? [viteSingleFile({ removeViteModuleLoader: true })] : []),
    ],
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
      cssCodeSplit: !isProductionBuild,
      sourcemap: false,
      rollupOptions: isProductionBuild
        ? undefined
        : {
            output: {
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