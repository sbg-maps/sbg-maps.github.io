import { defineConfig } from "vite";

// Served from https://sbg-maps.github.io/ on GitHub Pages; relative base also works for local previews.
// Two pages: the editor (index.html) and the mod page (mod/index.html).
export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: { main: "index.html", mod: "mod/index.html" },
    },
  },
});
