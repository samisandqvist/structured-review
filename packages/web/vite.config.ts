import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Preserve the browser's Host so the hub can enforce same-origin requests.
      "/api": { target: "http://localhost:3456", changeOrigin: false },
    },
  },
  build: { outDir: "dist" },
});
