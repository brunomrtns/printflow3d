import path from "path";
import fs from "fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const pkgJson = JSON.parse(
    fs.readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
  );
  const appVersion = pkgJson.version || "dev";

  // VITE_BASE_PATH: public path the app is served under. "/3dpanel/" in
  // production (behind trivestia-nginx), "/" in local development.
  // VITE_API_URL: public base URL of the API *without* the /api suffix
  // (e.g. "/3dpanel" in production, unset in dev — the dev server proxies
  // /api to the backend below). Vite exposes VITE_* env vars automatically.
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || "http://localhost:8080";

  return {
    base: env.VITE_BASE_PATH || "/",
    preview: {
      port: 5173,
    },
    server: {
      port: 5173,
      host: "0.0.0.0",
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
    define: {
      "import.meta.env.VITE_APP_TAG": JSON.stringify(appVersion),
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
      },
    },
  };
});
