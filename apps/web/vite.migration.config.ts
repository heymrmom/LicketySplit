import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: __dirname,
  base: "./",
  publicDir: false,
  build: {
    outDir: path.resolve(__dirname, "dist/legacy-migration"),
    emptyOutDir: true,
    target: "esnext",
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(__dirname, "migration.html"),
      output: {
        entryFileNames: "migration-assets/[name]-[hash].js",
        chunkFileNames: "migration-assets/[name]-[hash].js",
        assetFileNames: "migration-assets/[name]-[hash][extname]",
      },
    },
  },
});
