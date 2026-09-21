import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      try { return next(`${specifier.slice(0, -3)}.ts`, context); } catch { /* fall through */ }
    }
    return next(specifier, context);
  },
});
