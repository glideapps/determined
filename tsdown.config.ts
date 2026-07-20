import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    // Keep tsup's output names: .js/.d.ts for ESM (the package is
    // type=module), .cjs/.d.cts for CJS — as referenced from
    // package.json's exports map.
    fixedExtension: false,
    outDir: "dist",
    clean: true,
});
