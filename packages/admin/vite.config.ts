import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The panel is served by the Datum server itself at /admin/, so `base` is
 * "/admin/" and the bundle lands in the server package's static dir. Every
 * route is a hash route, which means one index.html covers the whole app and
 * the server needs no SPA rewrite rules.
 */
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../datum/public/admin",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/admin/api": { target: "http://localhost:8080", changeOrigin: true },
      "/v1": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
});
