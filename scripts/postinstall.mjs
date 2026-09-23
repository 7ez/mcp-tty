// patch-package (and typescript, for the `prepare` build step) are devDependencies.
// When mcp-tty is installed as someone else's dependency (nested, not the root/top-level
// install), npm doesn't install devDependencies for it — so `patch-package` may simply
// not be resolvable here. That's fine: the patch it applies only fixes a cosmetic,
// Windows-only stderr crash on session kill (see patches/), not a functional bug, so
// skipping it is safe. Don't let a missing devDependency fail the whole install.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

try {
  require.resolve("patch-package/package.json");
} catch {
  console.log("mcp-tty: patch-package not installed here (nested dependency install), skipping patch step.");
  process.exit(0);
}

const { execFileSync } = await import("node:child_process");
try {
  execFileSync(process.execPath, [require.resolve("patch-package/index.js")], { stdio: "inherit" });
} catch (err) {
  console.warn("mcp-tty: patch-package failed to apply, continuing anyway:", err.message);
}
