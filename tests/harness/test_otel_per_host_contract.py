"""The OpenTelemetry settings are resolved for each host (docs/configuration.md, "Where the tables of a host are").

A request is served with the settings of the host that it names (HostSpec::otel). The block of the configuration (the
defaults) is read only where no host is involved. A handler that read the defaults would answer for every host with the
tables of the first one.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_the_settings_of_each_host_are_resolved_once_by_the_configuration():
    config = read("src/config.cpp")
    assert "host.otel = apply_otel_override(cfg.otel_defaults, host.otel_override);" in config
    assert "for (auto& host : cfg.hosts) resolve(host);" in config and "for (auto& host : cfg.mcp_hosts) resolve(host);" in config
    health = read("src/health_runner.hpp")
    assert "OtelHostOverride otel_override;" in health and "OtelSettings otel;" in health
    server = read("src/server.hpp")
    assert "OtelSettings otel_defaults;" in server
    # A host overrides where its tables are, never the limits or the allowlist.
    override = read("src/otel_settings.hpp")
    override = override[override.index("struct OtelHostOverride"):override.index("struct OtelSettings")]
    for name in ("allowlist", "lookback", "limit", "features", "analytics", "body_search"):
        assert name not in override, name


def test_no_handler_reads_the_defaults_of_the_block():
    for path in sorted((ROOT / "src").glob("*.cpp")):
        text = path.read_text(encoding="utf-8", errors="replace")
        text = re.sub(r"//[^\n]*", "", text)
        # The old names of the members are gone: a handler reads host->otel.
        assert not re.search(r"\bcfg_?\.(traces|logs|metrics)\b(?!_on)", text), path.name
        if path.name in ("config.cpp",):
            continue
        uses = re.findall(r"otel_defaults[^\n]*", text)
        # The defaults are read to describe the instance (/api/version, the MCP tools' fallback), never to serve a host.
        allowed = {"server.cpp": 1, "api_mcp.cpp": 1}
        assert len(uses) <= allowed.get(path.name, 0), (path.name, uses)


def test_a_signal_that_is_off_for_a_host_answers_for_that_host_only():
    for name, code in (("api_traces.cpp", "traces_disabled"), ("api_logs.cpp", "logs_disabled"), ("api_metrics.cpp", "metrics_disabled")):
        text = read(f"src/{name}")
        assert code in text, name
    # The routes exist when the signal is on for one host at least.
    server = read("src/server.cpp")
    for call in ("cfg_.traces_on()", "cfg_.logs_on()", "cfg_.metrics_on()"):
        assert call in server, call


def test_the_access_audit_and_the_mcp_tools_follow_the_host():
    health = read("src/health_runner.cpp")
    assert "otel_system_reads(host.otel)" in health
    api = read("src/api_mcp.cpp")
    assert "observability_by_host[host.id] = mcp_observability_config(host.otel)" in api
    tools = read("src/mcp_tools.cpp")
    assert "observability_by_host.find(ctx.host)" in tools
