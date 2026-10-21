/** Omit the optional CDN download block without changing the fixed CPU/disk/TCP kernels. */
export function performanceScript(script: string, omitDownload: boolean) {
  if (!omitDownload) return script;
  const start = script.indexOf(" try:\n  start=time.perf_counter();total=0");
  const end = script.indexOf(" try:\n  samples=[]", start);
  if (start < 0 || end < 0) throw new Error("Performance probe download boundaries changed");
  return script.slice(0, start) + script.slice(end);
}
