import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  build: {
    // three.js is a single ~525 kB chunk, loaded only when the 3D view opens.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks cache across releases.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (/[\\/](yjs|lib0|y-websocket|y-protocols)[\\/]/.test(id)) return "yjs";
          if (/[\\/]three[\\/]/.test(id)) return "three";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": target,
      "/yjs": { target, ws: true },
    },
  },
});
