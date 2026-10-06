import { defineConfig } from "vite";

// Relative base so the build works from any folder, including the
// https://<user>.github.io/<repo>/ address GitHub Pages serves it from.
export default defineConfig({ base: "./" });
