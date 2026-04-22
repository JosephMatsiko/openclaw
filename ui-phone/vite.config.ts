import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Build output lands inside the main gateway's static root so the phone UI
// is served alongside the Control UI at /m/ without a second HTTP listener.
// dist/control-ui/ is populated by ui/; we drop our bundle at dist/control-ui/m/
// and the gateway's existing static mount hands it out.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "/m/",
  publicDir: path.resolve(here, "public"),
  build: {
    outDir: path.resolve(here, "..", "dist", "control-ui", "m"),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    // The Control UI's gateway handler has a hardcoded rewrite that strips
    // everything in the URL before "/assets/" to support mounting the UI
    // under a basePath. Any /m/assets/* request therefore collides with the
    // Control UI's own /assets/ dir. Output our bundle under /m/bundle/
    // instead so the rewrite doesn't misfire.
    assetsDir: "bundle",
  },
});
