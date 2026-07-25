import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const workspaceRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@deep-mix/shared-schema": path.join(workspaceRoot, "packages/shared-schema/src/index.ts"),
        "@deep-mix/core-governor": path.join(workspaceRoot, "packages/core-governor/src/index.ts"),
        "@deep-mix/persistence": path.join(workspaceRoot, "packages/persistence/src/index.ts"),
        "@shared": path.join(__dirname, "src/shared"),
      },
    },
    build: {
      outDir: "out/main",
      lib: {
        entry: path.resolve(__dirname, "src/main/index.ts"),
        formats: ["cjs"],
        fileName: () => "index.js",
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@deep-mix/shared-schema": path.join(workspaceRoot, "packages/shared-schema/src/index.ts"),
        "@shared": path.join(__dirname, "src/shared"),
      },
    },
    build: {
      outDir: "out/preload",
      lib: {
        entry: path.resolve(__dirname, "src/preload/index.ts"),
        formats: ["cjs"],
        fileName: () => "index.js",
      },
    },
  },
  renderer: {
    root: path.resolve(__dirname, "src/renderer"),
    resolve: {
      alias: {
        "@deep-mix/shared-schema": path.join(workspaceRoot, "packages/shared-schema/src/index.ts"),
        "@shared": path.join(__dirname, "src/shared"),
      },
    },
    build: {
      outDir: path.resolve(__dirname, "out/renderer"),
    },
    plugins: [react()],
  },
});
