import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / WASM image libraries must run from node_modules, not be bundled.
  serverExternalPackages: ["sharp", "heic-convert"],
};

export default nextConfig;
