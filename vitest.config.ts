import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// On Windows a lowercase drive letter in cwd ("c:\...") makes Vitest load its
// runner twice and every suite fails with "reading 'config'". Normalise it.
const upperDrive = (p: string) => p.replace(/^[a-z]:/, (d) => d.toUpperCase());
const root = upperDrive(fileURLToPath(new URL("./", import.meta.url)));

export default defineConfig({
  root,
  resolve: {
    alias: { "@": root },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
