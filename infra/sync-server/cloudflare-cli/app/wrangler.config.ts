import { defineWranglerConfig } from "wrangler/experimental-config";

/** Build the existing application artifacts with the cf Wrangler bundler. */
export default defineWranglerConfig({
  minify: true,
  types: {
    generate: false,
  },
});
