import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


EXPECTED_ENV = {
    "LISTEN_HOST",
    "LISTEN_PORT",
    "CH_HOSTS",
    "RESULT_PREVIEW_ROW_LIMIT",
    "QUERY_MAX_SQL_BYTES",
    "QUERY_DESCRIBE_MODE",
    "QUERY_FINAL_STATS_FROM_QUERY_LOG",
    "QUERY_FINAL_STATS_FLUSH_LOGS",
    "QUERY_SAMPLE_INTERVAL_MS",
    "QUERY_RESULT_BATCH_ROWS",
    "QUERY_RESULT_BATCH_BYTES",
    "QUERY_SSE_BATCH_EVENTS",
    "QUERY_SSE_BATCH_BYTES",
    "QUERY_SSE_QUEUE_MAX_BYTES",
    "QUERY_DESCRIBE_CACHE_ENTRIES",
    "QUERY_DESCRIBE_CACHE_TTL_MS",
    "CH_CLIENT_POOL_MAX_IDLE",
    "CH_CLIENT_POOL_IDLE_TTL_MS",
    "CH_CLIENT_POOL_VALIDATE_AFTER_IDLE_MS",
    "CH_CLIENT_POOL_REAPER_INTERVAL_MS",
    "FORMAT_CACHE_MAX_ENTRIES",
    "FORMAT_CACHE_MAX_BYTES",
    "FORMAT_CACHE_TTL_MS",
    "QUERY_SESSION_MAX_COUNT",
    "QUERY_SESSION_ABANDONED_TTL_MS",
    "QUERY_SESSION_TERMINAL_TTL_MS",
    "QUERY_SESSION_REAPER_INTERVAL_MS",
}


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_config_mode_has_an_auditable_environment_boundary() -> None:
    main = read("src/main.cpp")
    header = read("src/config.hpp")
    source = read("src/config.cpp")

    assert "--config" in main
    assert "load_config_from_file(*cli.config_path)" in main
    assert "load_config_from_environment()" in main
    assert "std::getenv" not in main
    assert "never reads the process environment" in header

    env_calls = set(
        re.findall(
            r'env_(?:string|int|bool|describe_mode)\("([A-Z0-9_]+)"',
            source,
        )
    )
    assert env_calls == EXPECTED_ENV


def test_every_environment_option_is_documented_with_an_hcl_equivalent() -> None:
    docs = read("docs/configuration.md")
    for key in EXPECTED_ENV:
        assert f"`{key}`" in docs

    example = read("config.example.hcl")
    for block in ("server", "query", "client_pool", "format_cache", "health", "clickhouse"):
        assert re.search(rf"^{block} \{{", example, re.MULTILINE)


def test_password_file_is_native_and_uri_passwords_are_rejected_when_combined() -> None:
    config = read("src/config.cpp")
    uri = read("src/ch_uri.cpp")
    example = read("config.example.hcl")

    assert '"password_file"' in config
    assert '"runner_password_file"' in config
    assert '"system_password_file"' in config
    assert "password_file = \"/run/secrets/clickhouse_password\"" in example
    assert "read_password_file" in uri
    assert "URI password and password_file are mutually exclusive" in uri
    assert "opt.SetPassword(*password)" in uri


def test_hcl_duplicate_attributes_are_rejected() -> None:
    source = read("src/hcl.cpp")
    assert "duplicate attribute" in source
