import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/upload": "http://localhost:8000",
      "/image": "http://localhost:8000",
      "/landmarks": "http://localhost:8000",
      "/angles": "http://localhost:8000",
      "/side": "http://localhost:8000",
      "/export": "http://localhost:8000",
      "/config": "http://localhost:8000",
      "/osteotomy": "http://localhost:8000",
      "/calibrate": "http://localhost:8000",
      "/health": "http://localhost:8000",
      "/billing": "http://localhost:8000",
    },
  },
});
