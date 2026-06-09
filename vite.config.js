import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // host: true makes the dev server reachable from other machines on your LAN
  // (e.g. http://192.168.1.x:5173), not just localhost on the server itself.
  server: { host: true, port: 5173 },
});
