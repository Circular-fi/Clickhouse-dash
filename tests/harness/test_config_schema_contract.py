"""The table of keys (src/config_keys.def) is the one place that knows a setting. Three things hang on it:
docs/configuration-reference.md is generated from it, config.example.hcl uses only its keys, and every key that the
configuration file reads outside the table is listed in it as read by code.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def table():
    """{block: {key}} of the rows of the table."""
    sys.path.insert(0, str(ROOT / "tools"))
    import gen_config_reference as tool

    out = {}
    for block, key, *_ in tool.rows():
        out.setdefault(block, set()).add(key)
    return out


def test_the_reference_is_the_output_of_the_generator():
    result = subprocess.run([sys.executable, str(ROOT / "tools/gen_config_reference.py"), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_the_prose_points_at_the_reference_and_the_table_has_no_clamp():
    docs = (ROOT / "docs/configuration.md").read_text()
    assert "configuration-reference.md" in docs
    config = (ROOT / "src/config.cpp").read_text()
    # The bounds are in the table: config.cpp clamps nothing.
    assert "std::max(" not in config.split("void finish_config")[0]
    assert "normalize_config" not in config
    for site in ("query_session.cpp", "health_runner.cpp"):
        assert "std::max<size_t>(16 * 1024, std::min<size_t>(4 * 1024 * 1024" not in (ROOT / "src" / site).read_text()


def test_the_example_file_uses_only_keys_of_the_table():
    keys = table()
    stack = []
    unknown = []
    for raw in (ROOT / "config.example.hcl").read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        opened = re.match(r"^(\w+)\s*\{\s*$", line)
        if opened:
            stack.append(opened.group(1))
            continue
        if line == "}":
            stack.pop()
            continue
        assign = re.match(r"^(\w+)\s*=", line)
        if not assign or not stack:
            continue
        block = ".".join(stack)
        if block == "traces" or block == "logs" or block == "metrics":
            block = "observability." + block
        if block not in keys:
            continue  # clickhouse { host { } }, mcp.key, features: read by code and described in their own docs
        if assign.group(1) not in keys[block]:
            unknown.append(f"{block}.{assign.group(1)}")
    assert not unknown, unknown


def test_the_loader_reads_the_blocks_of_the_table_through_it():
    config = (ROOT / "src/config.cpp").read_text()
    assert "config::apply_block(" in config
    assert 'CFG_' not in config
    schema = (ROOT / "src/config_schema.cpp").read_text()
    assert '#include "config_keys.def"' in schema
