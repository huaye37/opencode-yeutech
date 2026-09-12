import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 18140,
    strictPort: true,
    proxy: {
      "/api/agent": {
        target: process.env.YEUTECH_AGENT_WEB_TARGET ?? "http://127.0.0.1:18141",
        changeOrigin: false,
        rewrite: (requestPath) => requestPath.replace(/^\/api\/agent/, ""),
        headers: process.env.YEUTECH_AGENT_BFF_TOKEN
          ? { authorization: `Bearer ${process.env.YEUTECH_AGENT_BFF_TOKEN}` }
          : {},
      },
    },
  },
});
