// The address of a static file of this server (src/static/<file>): the one place that builds it.
//
//   assetUrl(file)   the absolute URL, under the page's own base path (a reverse-proxy prefix included): the
//                    directory of this very module. A staged build (tools/stage_static.py) gives every script, sheet
//                    and kernel its content hash in window.__chdashAssetVersions; the address then carries ?v=<hash>
//                    and never changes content, so the browser keeps the file without asking again.
//
// It runs in a page and in a Worker (a Worker has no version map: the page hands it the addresses it needs).
const base = new URL("./", import.meta.url);
const versions = globalThis.__chdashAssetVersions || {};

export function assetUrl(file) {
  const name = String(file || "");
  const out = new URL(name, base);
  const hash = versions[`static/${name}`];
  if (hash) out.searchParams.set("v", hash);
  return out.toString();
}
