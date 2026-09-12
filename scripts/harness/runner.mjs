export async function runChecks(checks, execute) {
  if (!checks.length) throw new Error("required check set is empty");
  const results = [];
  for (const check of checks) {
    const start = performance.now();
    let exit;
    try {
      exit = await execute(check.command);
    } catch {
      exit = 1;
    }
    results.push({ name: check.name, exit: exit ?? 1, seconds: (performance.now() - start) / 1000 });
  }
  return { ok: results.every((r) => r.exit === 0), checks: results };
}
