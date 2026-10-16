// The address of a static file of this server (src/static/<file>). One place builds this address.
//
//   assetUrl(file)   The absolute URL, under the base path of the page (a reverse-proxy prefix included).
//                    The base is the directory of this module. A staged build (tools/stage_static.py) gives every script, sheet
//                    and kernel its content hash in window.__chdashAssetVersions. The address then carries ?v=<hash>.
//                    The content behind such an address never changes, so the browser keeps the file without a new request.
//
// The code runs in a page and in a Worker. A Worker has no version map, so the page gives it the addresses that it needs.
const base = new URL("./", import.meta.url);
const versions = globalThis.__chdashAssetVersions || {};

export function assetUrl(file) {
  const name = String(file || "");
  const out = new URL(name, base);
  const hash = versions[`static/${name}`];
  if (hash) out.searchParams.set("v", hash);
  return out.toString();
}
