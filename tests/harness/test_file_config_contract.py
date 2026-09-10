from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_config_is_hcl_only_and_config_is_required() -> None:
    main = read("src/main.cpp")
    header = read("src/config.hpp")
    source = read("src/config.cpp")

    assert "--config is required" in main
    assert "load_config_from_file(*cli.config_path)" in main
    assert "load_config_from_environment" not in main
    assert "load_config_from_environment" not in header
    assert "std::getenv" not in source
    assert "getenv(" not in source
    assert "HCL-only startup path" in header


def test_complete_hcl_schema_includes_evolution_blocks() -> None:
    example = read("config.example.hcl")
    for block in (
        "server", "query", "client_pool", "format_cache", "health",
        "explorer", "analysis", "export", "clickhouse",
    ):
        assert f"{block} {{" in example

    source = read("src/config.cpp")
    assert '"explorer", "analysis", "export", "clickhouse"' in source
    assert 'optional_block(root, "auth"' not in source
    assert 'export.archive_format must be zip' in source


def test_password_file_is_native_and_uri_passwords_are_rejected_when_combined() -> None:
    config = read("src/config.cpp")
    uri = read("src/ch_uri.cpp")
    example = read("config.example.hcl")

    assert '"password_file"' in config
    assert '"runner_password_file"' in config
    assert '"system_password_file"' in config
    assert 'runner_password_file = "/run/secrets/chdash_runner_password"' in example
    assert 'system_password_file = "/run/secrets/chdash_system_password"' in example
    assert "read_password_file" in uri
    assert "URI password and password_file are mutually exclusive" in uri
    assert "opt.SetPassword(*password)" in uri


def test_hcl_duplicate_attributes_are_rejected() -> None:
    source = read("src/hcl.cpp")
    assert "duplicate attribute" in source
