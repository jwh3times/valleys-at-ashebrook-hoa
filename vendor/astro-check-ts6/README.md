# Astro check TypeScript 6 bridge

The project compiler is TypeScript 7. Astro's language server still requires the programmatic
TypeScript API, which TypeScript 7 does not currently expose. This isolated private package keeps
the official `@astrojs/check@0.9.10` package unchanged while resolving TypeScript 6 only within the
checker environment. The root `postinstall` script installs its locked dependencies, and
`npm run check` invokes its checker after the TypeScript 7 compiler succeeds.

Remove this adapter and restore the direct `@astrojs/check` dependency when Astro supports the
TypeScript 7 compiler API. Track upstream support at
<https://github.com/withastro/roadmap/discussions/1321>.
