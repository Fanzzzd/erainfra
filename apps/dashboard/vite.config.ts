import path from "node:path";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@convex": path.resolve(import.meta.dirname, "../../convex"),
    },
  },
  server: {
    fs: {
      allow: [path.resolve(import.meta.dirname, "../..")],
    },
  },
});
