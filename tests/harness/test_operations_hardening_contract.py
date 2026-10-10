"""Source contract of the operations and HTTP hardening (docs/operations.md, SECURITY.md "Safe deployment").

The behaviour is tested in backend-functional/test_http_hardening.py, test_trace_hidden_parents.py,
frontend/specs/http-security.spec.js, native/mcp_test.cpp and smoke/release_smoke.py; this file keeps the wiring that
those tests cannot see from outside (every route, every serialization, every random identifier).
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_every_answer_has_the_security_headers_and_the_hooks():
    hooks = read("src/server_http.cpp")
    assert "http_.set_default_headers(security_headers());" in hooks
    assert "http_.set_pre_routing_handler(" in hooks and "http_.set_post_routing_handler(" in hooks
    assert "http_.set_exception_handler(" in hooks and "http_.set_error_handler(" in hooks
    # The exception text is logged (cut), never sent.
    handler = hooks.split("http_.set_exception_handler(", 1)[1].split("http_.set_error_handler(", 1)[0]
    assert 'refuse(res, 500, "internal_error", "Internal server error.");' in handler
    assert "cut(what, 300)" in handler
    assert "install_http_hooks();" in read("src/server.cpp")
    guard = read("src/http_guard.cpp")
    for header in ("Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy",
                   "Cross-Origin-Resource-Policy"):
        assert f'{{"{header}", ' in guard, header
    assert "frame-ancestors 'none'" in guard and "'unsafe-eval'" not in guard.replace("'wasm-unsafe-eval'", "")


def test_a_page_shell_gets_the_hashes_of_its_inline_scripts_on_both_static_paths():
    embedded = read("src/serve_embedded_static.hpp")
    server = read("src/server.cpp")
    assert "if (html) set_page_security_policy(res, std::string_view(reinterpret_cast<const char*>(a->data), a->size));" in embedded
    assert "if (html) set_page_security_policy(res, asset->body);" in server


def test_immutable_only_when_the_version_is_the_hash_of_the_bytes():
    embedded = read("src/serve_embedded_static.hpp")
    server = read("src/server.cpp")
    assert '!asset_version_matches(req.get_param_value("v"), a->content_hash)' in embedded
    assert '!asset_version_matches(req.get_param_value("v"), asset->content_hash)' in server
    assert embedded.count('res.set_header("Cache-Control", "no-store");') == 1
    assert "loaded->content_hash.push_back" in server


def test_one_guard_for_every_write():
    hooks = read("src/server_http.cpp")
    before = hooks.split("Server::before_routing(", 1)[1].split("\n}\n", 1)[0]
    assert 'if (is_write(req.method) && req.path != "/mcp") {' in before
    assert 'return method == "POST" || method == "PUT" || method == "PATCH" || method == "DELETE";' in hooks
    # No route keeps a copy of its own.
    for path in sorted((ROOT / "src").glob("*.cpp")):
        if path.name in ("http_guard.cpp",):
            continue
        text = path.read_text(encoding="utf-8")
        assert "Sec-Fetch-Site" not in text, path.name
        assert "bool allow_mutation(" not in text, path.name


def test_capability_identifiers_come_from_the_system_random_source():
    for path in sorted((ROOT / "src").glob("*.[ch]pp")):
        if path.name == "secure_random.hpp":  # its comment says why not
            continue
        text = path.read_text(encoding="utf-8")
        assert "mt19937" not in text, path.name
        assert "random_device" not in text, path.name
    assert "const std::string qid = random_uuid_v4();" in read("src/api_query.cpp")
    assert "job.export_id = random_uuid_v4();" in read("src/api_export.cpp")
    assert "static const std::string token = random_hex(16);" in read("src/mcp_identity.cpp")
    assert "jwt_(secure_random_bytes(32))" in read("src/server.cpp")


def test_probes_routes_and_image_health_check():
    server = read("src/server.cpp")
    for route in ('http_.Get("/livez"', 'http_.Get("/readyz"', 'http_.Get("/healthz"'):
        assert route in server, route
    hooks = read("src/server_http.cpp")
    ready = hooks.split("void Server::handle_readyz(", 1)[1].split("\n}\n", 1)[0]
    assert "const bool ready = !stopping() && healthy > 0;" in ready
    live = hooks.split("void Server::handle_livez(", 1)[1].split("\n}\n", 1)[0]
    assert "health_" not in live
    dockerfile = read("tests/Dockerfile.source")
    assert 'HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["/usr/local/bin/chdash-source-entrypoint", "--health"]' in dockerfile


def test_the_stop_drains_streams_exports_and_query_threads():
    server = read("src/server.cpp")
    dtor = server.split("Server::~Server() {", 1)[1].split("\n}\n", 1)[0]
    assert "query_workers_->close_and_wait(" in dtor and "std::_Exit(1);" in dtor
    assert "session->set_worker_group(query_workers_);" in read("src/api_query.cpp")
    session = read("src/query_session.cpp")
    start = session.split("void QuerySession::start() {", 1)[1].split("\n}\n", 1)[0]
    assert "self.reset();\n      if (group) group->leave();" in start
    stream = read("src/api_query_stream.cpp")
    assert '"server_stopping"' in stream and "self->stopping()" in stream
    export = read("src/api_export.cpp")
    assert "add_stop_hook([host_copy, query_id] { cancel_export_best_effort(host_copy, query_id); })" in export
    hosts = read("src/api_hosts.cpp")
    assert "if (stopping()) {\n          sink.done();" in hosts


def test_every_span_serialization_hides_a_hidden_parent():
    traces = read("src/api_traces.cpp")
    writes = traces.count('w.Key("parent_span_id");')
    assert writes == 4
    assert len(re.findall(r'const std::string_view parent = visible_parent\(', traces)) == 3
    assert 'span.parent_span_id = std::string(visible_parent(span.parent_span_id, visibility == "1", &visible_span_ids));' in traces
    assert 'w.Uint64(visibility == "1" ? row.missing_parents : 0);' in traces
    assert '(all_services ? "" : " AND has(visible_targets, s)")' in traces


def test_the_log_is_one_json_line_per_event():
    for path in sorted((ROOT / "src").glob("*.cpp")):
        if path.name in ("main.cpp", "log.cpp"):
            continue
        assert "std::cerr" not in path.read_text(encoding="utf-8"), path.name
    log = read("src/log.cpp")
    assert "std::lock_guard<std::mutex> lock(mu);" in log and "std::cerr.write(line.data()" in log
    hooks = read("src/server_http.cpp")
    assert '"http.request"' in hooks and '"http.stream_end"' in hooks
    # The query string can hold an export token: never logged.
    assert "req.target" not in hooks
