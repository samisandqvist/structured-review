module.exports = {
  forbidden: [
    { name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
    {
      name: "web-uses-api-only",
      severity: "error",
      from: { path: "^packages/web/" },
      to: { path: "^packages/(server|skill)/" },
    },
    {
      name: "server-independent-of-clients",
      severity: "error",
      from: { path: "^packages/server/" },
      to: { path: "^packages/(web|skill)/" },
    },
    {
      name: "production-not-tests",
      severity: "error",
      from: { path: "^packages/[^/]+/src/", pathNot: "/test/" },
      to: { path: String.raw`(\.test\.[cm]?[jt]sx?$|/tests?/)` },
    },
    { name: "no-unresolved", severity: "error", from: {}, to: { couldNotResolve: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "node", "default"] },
  },
};
