import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function readToken() {
  if (process.env.YEUTECH_AGENT_BFF_TOKEN_FILE) {
    return readFileSync(process.env.YEUTECH_AGENT_BFF_TOKEN_FILE, "utf8").trim();
  }
  return process.env.YEUTECH_AGENT_BFF_TOKEN?.trim() || "";
}

export default defineConfig(() => {
  const token = readToken();
  return {
    plugins: [react()],
    server: {
      port: 18140,
      strictPort: true,
      proxy: {
        "/api/agent": {
          target: process.env.YEUTECH_AGENT_WEB_TARGET ?? "http://127.0.0.1:18141",
          changeOrigin: false,
          rewrite: (requestPath) => requestPath.replace(/^\/api\/agent/, ""),
          headers: token ? { authorization: `Bearer ${token}` } : {},
        },
      },
    },
  };
});
