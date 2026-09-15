import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: path.resolve(__dirname, "../web/studio-assets"),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(__dirname, "src/main.tsx"),
      formats: ["iife"],
      name: "AutoSocialStudio",
      fileName: () => "studio.js",
      cssFileName: "studio",
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => assetInfo.name === "style.css" ? "studio.css" : "[name][extname]",
      },
    },
  },
});
