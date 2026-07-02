export function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}`;
}

export const isTestFile = (p: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)(test|tests|__tests__)\//.test(p);
