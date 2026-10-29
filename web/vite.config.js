import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" + hash routing means the built site works from any path or
// static host without server-side rewrites.
export default defineConfig({
  plugins: [react()],
  base: "./",
  test: { environment: "jsdom" },
});
