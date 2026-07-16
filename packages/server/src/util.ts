export function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}`;
}

/**
 * Per-language test-file detection (roadmap Phase 2), by filename shape:
 * TS/JS `*.test.ts` / `*.spec.tsx` …, Python `test_*.py` / `*_test.py` /
 * `conftest.py`, Java Maven `src/test/java/` trees plus surefire/failsafe
 * naming (`*Test.java`, `*IT.java`), and the shared test-directory rule.
 */
export const isTestFile = (p: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  /(^|\/)(test_[^/]*|[^/]+_test|conftest)\.py$/.test(p) ||
  /(^|\/)src\/test\/java\//.test(p) ||
  /(Test|IT)\.java$/.test(p) ||
  /(^|\/)(test|tests|__tests__)\//.test(p);
