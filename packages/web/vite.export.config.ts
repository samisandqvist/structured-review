// The exported component map page: one script and one stylesheet with no
// chunks, so `srev map export` can inline them into a single HTML file.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The page links nothing, so public files (served by the hub) stay out.
  publicDir: false,
  build: {
    outDir: "dist/export",
    emptyOutDir: true,
    rollupOptions: {
      input: "export.html",
      output: {
        inlineDynamicImports: true,
        entryFileNames: "map.js",
        assetFileNames: "map[extname]",
      },
    },
  },
});
