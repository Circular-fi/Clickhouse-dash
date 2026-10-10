#pragma once

// The HTTP hardening of every answer (docs/operations.md, "HTTP security"): the guard of the writes against
// requests that a page of another site sends with the browser of a user, the security headers, the policy of
// the page shells, and the check of the version of a static asset.

#include <httplib.h>

#include <optional>
#include <string>
#include <string_view>

namespace chdash {

// ---- the guard of the writes -----------------------------------------------------------------------------

// Why a request is refused, as the JSON error says it ({"error", "error_code", "message"}).
struct RequestRefusal {
  int status = 403;
  const char* code = "";
  const char* message = "";
};

// True when a page of another site sent the request through the browser of the user. Sec-Fetch-Site (set by the
// browser, never by page script) is present and is neither same-origin nor none; or it is absent and the Origin
// header names another server than Host (or the first X-Forwarded-Host). A request without both headers (a CLI, a
// script, a test, the MCP API tools) is not cross-site: ChDash has no login, so only a browser needs this guard.
bool is_cross_site_request(const httplib::Request& req);

// The media type of Content-Type, lower case, without its parameters ("" when absent).
std::string request_media_type(const httplib::Request& req);

// The request has a body: a Content-Length above 0, or a Transfer-Encoding.
bool request_has_body(const httplib::Request& req);

// The guard of every POST, PUT, PATCH and DELETE of ChDash except the MCP endpoint (which has its own Origin list):
// a cross-site request is refused (403 cross_site_request), and a body must be application/json (415
// unsupported_media_type). A page of another site cannot send application/json without a CORS preflight, which
// ChDash never grants, so no write, run, format or export can start from it. Runs before the body is read.
std::optional<RequestRefusal> check_browser_write(const httplib::Request& req);

// ---- the security headers --------------------------------------------------------------------------------

// The policy of every answer that is not a page shell: what a page of ChDash needs and nothing more. Scripts and
// workers of this server only, WebAssembly compiled from them ('wasm-unsafe-eval': the kernels, docs/wasm.md),
// inline styles (the pages set style attributes), images from this server, data: and blob: URLs, and no framing.
extern const char* const kContentSecurityPolicy;

// The headers that every answer carries: Content-Security-Policy, X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy and Cross-Origin-Resource-Policy. (Not Cross-Origin-Opener-Policy: a browser ignores it on a plain
// HTTP origin and reports an error in the console of every page.)
httplib::Headers security_headers();

// The policy of a page shell: kContentSecurityPolicy with the hash ('sha256-<base64>') of each inline script
// of `html` added to script-src, so these scripts run and no other inline script does.
std::string page_content_security_policy(std::string_view html);

// Replaces the Content-Security-Policy of `res` with the policy of the page `html`.
void set_page_security_policy(httplib::Response& res, std::string_view html);

// ---- static assets ---------------------------------------------------------------------------------------

// True when `version` (the ?v= of an asset address) is the version of the bytes that are served: 8 to 64 lower-case
// hexadecimal digits that start the SHA-256 of the asset in hexadecimal (`content_hash`, tools/stage_static.py and
// tools/icons.py). Only then is the answer immutable: an old or made-up ?v= gets the new bytes, never cached.
bool asset_version_matches(std::string_view version, std::string_view content_hash);

// ---- request ids -----------------------------------------------------------------------------------------

// The id of a request for the log and the X-Request-Id answer header: the X-Request-Id of the request when a proxy
// set one (1 to 128 characters of [A-Za-z0-9._:-]), else a new one.
std::string request_id_for(const httplib::Request& req);

} // namespace chdash
