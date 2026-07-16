import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api/events": { target: "ws://127.0.0.1:7373", ws: true },
      "/api": { target: "http://127.0.0.1:7373" },
    },
  },
});
