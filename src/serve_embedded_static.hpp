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
  return "application/octet-stream";
}

// Serve embedded assets.
// URL mapping:
//   GET /            -> index.html
//   GET /static/...  -> (strip "/static/") and look up in embedded files
//   GET /<anything>  -> tries "<anything>" as embedded path (useful if your frontend uses root paths)
inline bool try_serve_embedded(const httplib::Request& req, httplib::Response& res) {
#ifndef CHDASH_EMBED_STATIC
  (void)req; (void)res;
  return false;
#else
  std::string path = req.path;

  // normalize
  if (path.empty() || path == "/") path = "/index.html";

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

  const auto* a = chdash_embedded::find(rel);
  if (!a) return false;

  res.set_header("Cache-Control", "public, max-age=31536000, immutable");
  res.set_content(
      reinterpret_cast<const char*>(a->data),
      a->size,
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
