#pragma once
#include <string>
#include <string_view>

#include "httplib.h"

// This header expects that CMake generated:
//   - embedded_static.hpp
//   - embedded_static.cpp
// with namespace "chdash_embedded".
#ifdef CHDASH_EMBED_STATIC
  #include "embedded_static.hpp"
#endif

namespace chdash {

// Very small mime mapper (extend if you need more)
inline const char* mime_from_path(std::string_view p) {
  auto dot = p.find_last_of('.');
  if (dot == std::string_view::npos) return "application/octet-stream";
  auto ext = p.substr(dot + 1);
  if (ext == "html") return "text/html; charset=utf-8";
  if (ext == "css")  return "text/css; charset=utf-8";
  if (ext == "js")   return "application/javascript; charset=utf-8";
  if (ext == "json") return "application/json; charset=utf-8";
  if (ext == "svg")  return "image/svg+xml";
  if (ext == "png")  return "image/png";
  if (ext == "jpg" || ext == "jpeg") return "image/jpeg";
  if (ext == "gif")  return "image/gif";
  if (ext == "ico")  return "image/x-icon";
  if (ext == "txt")  return "text/plain; charset=utf-8";
  if (ext == "woff") return "font/woff";
  if (ext == "woff2")return "font/woff2";
  if (ext == "wasm") return "application/wasm";
  return "application/octet-stream";
}

// Cache-Control of a static asset. Asset URLs are stable rather than content-hashed, so most
// assets revalidate cheaply and a newly deployed binary is never paired with stale JavaScript
// from cache. A web font never changes under its file name (a new face ships under a new name),
// so browsers keep fonts for a week without asking. A versioned address (?v=<content hash>,
// the icon sprite: tools/icons.py) never changes content, so browsers keep it for a year.
inline const char* cache_control_for(std::string_view p, bool versioned = false) {
  if (versioned) return "public, max-age=31536000, immutable";
  auto dot = p.find_last_of('.');
  if (dot != std::string_view::npos && p.substr(dot + 1) == "woff2") return "public, max-age=604800";
  return "public, max-age=0, must-revalidate";
}

// True when the client lists gzip among its Accept-Encoding codings (and does not refuse it with q=0).
inline bool accepts_gzip(const httplib::Request& req) {
  const std::string value = req.get_header_value("Accept-Encoding");
  const auto at = value.find("gzip");
  if (at == std::string::npos) return false;
  const auto end = value.find(',', at);
  const std::string_view coding = std::string_view(value).substr(at, end == std::string::npos ? std::string::npos : end - at);
  return coding.find("q=0") == std::string_view::npos || coding.find("q=0.") != std::string_view::npos;
}

// Serve embedded assets.
// URL mapping:
//   GET /            -> query.html (the Query page shell)
//   GET /static/...  -> (strip "/static/") and look up in embedded files
//   GET /<anything>  -> tries "<anything>" as embedded path (useful if your frontend uses root paths)
inline bool try_serve_embedded(const httplib::Request& req, httplib::Response& res) {
#ifndef CHDASH_EMBED_STATIC
  (void)req; (void)res;
  return false;
#else
  std::string path = req.path;

  // normalize
  if (path.empty() || path == "/") path = "/query.html";

  std::string rel;
  if (path.rfind("/static/", 0) == 0) {
    rel = path.substr(std::string("/static/").size());
  } else if (path.rfind("/", 0) == 0) {
    rel = path.substr(1);
  } else {
    rel = path;
  }

  // prevent traversal (shouldn't happen, but cheap)
  if (rel.find("..") != std::string::npos) return false;

  // The compressed copies (tools/stage_static.py) are answers, never addresses of their own.
  if (rel.size() > 3 && rel.compare(rel.size() - 3, 3, ".gz") == 0) return false;

  const auto* a = chdash_embedded::find(rel);
  if (!a) return false;

  // A client that accepts gzip gets the pre-compressed copy when the stage made one.
  const auto* packed = accepts_gzip(req) ? chdash_embedded::find(rel + ".gz") : nullptr;
  const auto* sent = packed ? packed : a;
  // A shell is served for many paths and may be asked for with a ?v= of the page's own, so only scripts
  // and stylesheets are ever immutable.
  const bool html = rel.size() > 5 && rel.compare(rel.size() - 5, 5, ".html") == 0;

  std::string etag;
  etag.reserve(std::char_traits<char>::length(sent->content_hash) + 2);
  etag.push_back('"');
  etag += sent->content_hash;
  etag.push_back('"');
  res.set_header("ETag", etag);
  res.set_header("Vary", "Accept-Encoding");
  res.set_header("Cache-Control", cache_control_for(rel, req.has_param("v") && !html));
  if (req.has_header("If-None-Match") && req.get_header_value("If-None-Match") == etag) {
    res.status = 304;
    return true;
  }
  if (packed) res.set_header("Content-Encoding", "gzip");
  res.set_content(
      reinterpret_cast<const char*>(sent->data),
      sent->size,
      mime_from_path(rel)
  );
  return true;
#endif
}

// Installs a catch-all GET handler that serves embedded assets.
// Put this BEFORE your API routes if you want assets to win,
// or AFTER your API routes if you want /api/... to win.
inline void install_embedded_static_routes(httplib::Server& svr) {
#ifdef CHDASH_EMBED_STATIC
  svr.Get(R"(/(.*))", [&](const httplib::Request& req, httplib::Response& res) {
    (void)try_serve_embedded(req, res);
  });
#else
  (void)svr;
#endif
}

} // namespace chdash
