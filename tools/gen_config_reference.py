#!/usr/bin/env python3
"""Writes docs/configuration-reference.md from the table of keys, src/config_keys.def.

The table is the one place that says what a key is (type, bounds, default, use). The reference is generated
from it, so it cannot disagree with the code. A test (tests/harness/test_config_schema_contract.py) runs
`--check`, which fails when the file is not the output of this tool.

    python3 tools/gen_config_reference.py            write docs/configuration-reference.md
    python3 tools/gen_config_reference.py --check    exit 1 when the file is out of date
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEF = ROOT / "src" / "config_keys.def"
OUT = ROOT / "docs" / "configuration-reference.md"

BLOCK_ORDER = [
    "server", "query", "client_pool", "generated_queries", "admission", "format_cache", "health", "explorer", "explorer.graph",
    "system", "analysis", "export", "query_library", "observability", "observability.traces", "observability.logs",
    "observability.metrics", "clickhouse.host", "clickhouse.host.observability.traces", "clickhouse.host.observability.logs",
    "clickhouse.host.observability.metrics", "mcp", "mcp.usage", "mcp.keys", "mcp.mcp_key", "mcp.mcp_key.scope", "mcp.mcp_key.limits",
    "mcp.key", "telemetry", "access", "access.identity", "access.pdp",
]


def split_arguments(text):
    """The arguments of a CFG_ row: split at the commas that stand outside a string."""
    out, current, quoted, escaped = [], [], False, False
    for ch in text:
        if quoted:
            current.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                quoted = False
            continue
        if ch == '"':
            quoted = True
            current.append(ch)
        elif ch == ",":
            out.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
    out.append("".join(current).strip())
    return out


def unquote(text):
    assert text.startswith('"') and text.endswith('"'), text
    return bytes(text[1:-1], "utf-8").decode("unicode_escape")


def rows():
    """(block, key, type, default, range, unit, description) of each row of the table."""
    out = []
    for line in DEF.read_text().splitlines():
        match = re.match(r"^CFG_(INT|BOOL|STRING|ENUM|CUSTOM)\((.*)\)\s*$", line)
        if not match:
            continue
        kind, body = match.groups()
        args = split_arguments(body)
        if kind == "INT":
            block, key, _ctype, _field, default, lo, hi, zero, unit, doc = args
            rng = ("0 or " if zero == "true" else "") + f"{int(lo)} to {int(hi)}"
            out.append((unquote(block), unquote(key), "integer", unquote(default), rng, unquote(unit), unquote(doc)))
        elif kind == "BOOL":
            block, key, _field, default, doc = args
            out.append((unquote(block), unquote(key), "boolean", unquote(default), "", "", unquote(doc)))
        elif kind == "STRING":
            block, key, _field, default, doc = args
            out.append((unquote(block), unquote(key), "text", unquote(default), "", "", unquote(doc)))
        elif kind == "ENUM":
            block, key, _field, default, choices, doc = args
            out.append((unquote(block), unquote(key), "one of " + unquote(choices), unquote(default), "", "", unquote(doc)))
        else:
            block, key, ctype, default, rng, doc = args
            out.append((unquote(block), unquote(key), unquote(ctype), unquote(default), unquote(rng), "", unquote(doc)))
    return out


def cell(text):
    """The text of a table cell: a bar would end the cell."""
    return text.replace("|", "\\|")


def render():
    all_rows = rows()
    blocks = []
    for block in BLOCK_ORDER:
        if any(r[0] == block for r in all_rows):
            blocks.append(block)
    for r in all_rows:
        if r[0] not in blocks:
            raise SystemExit(f"config_keys.def: the block {r[0]} is not in BLOCK_ORDER of tools/gen_config_reference.py")
    lines = [
        "# Configuration keys",
        "",
        "This file is generated from `src/config_keys.def`. Do not edit it: run `python3 tools/gen_config_reference.py`.",
        "",
        "Each key is in the block of the configuration file that its section names (`observability.traces` is",
        "`observability { traces { ... } }`). A value outside its range stops the start with an error that names the key.",
        "`chdash --config <file> --print-config` writes the value of every key as it applies, and where the value comes from.",
        "The blocks `clickhouse.host`, `mcp.mcp_key`, `mcp.key` and `query_library` can appear more than once. Each block is one host, one key or one library.",
        "An `mcp_key` block has the name of its key as its label: `mcp_key \"ci-bot\" { ... }`. No other block takes a label.",
        "The block `mcp.key` is the older form of `mcp.mcp_key`: ChDash reads it for one release and writes a warning.",
        "The block `access` is required: a file without it stops the start ([access.md](access.md)).",
        "The prose of the keys is in [configuration.md](configuration.md).",
        "",
        "## Secrets",
        "",
        "A secret is never written in the file: a password in a URI, or a `token` or `secret` in a key, stops the start. A secret has two forms,",
        "and each form is a key of its own in the tables below:",
        "",
        "- `<name>_env` gives the name of an environment variable. The value of the secret is the value of the variable.",
        "- `<name>_file` gives the path of a file. The value of the secret is the content of the file, without its last line end.",
        "",
        "Give exactly one of the two forms. A variable that is not set or is empty, and a file that cannot be read or is empty,",
        "stop the start. ChDash reads each secret one time, at start. ChDash reads no environment variable that the file does not name.",
        "The keys that accept `_env` and `_file` are the ones whose type is `environment variable name` or `file path` in the sections",
        "`clickhouse.host`, `mcp.mcp_key`, `mcp.key` and `access.pdp`. `--print-config` shows the source of a secret (`env:VAR` or `file:/path`), never its value.",
        "",
        "## Values from the environment or from a file",
        "",
        "An attribute that is not a secret can also take its value from a different place, when the file tells it. Such an attribute",
        "`<name>` has three forms: `<name>` (the value is in the file), `<name>_env` (an environment variable) and `<name>_file` (a file,",
        "without its last line end). Give only one of the three forms. The same rules as for a secret apply to `_env` and `_file`.",
        "These attributes have the three forms: `otlp_endpoint` of the section `telemetry`, `public_keys` of the section `access.identity`",
        "and `url` of the section `access.pdp`. `--print-config` shows the value of each one and its source.",
        "",
    ]
    for block in blocks:
        lines += [f"## `{block}`", "", "| Key | Type | Default | Range | Use |", "|---|---|---|---|---|"]
        for (b, key, ctype, default, rng, unit, doc) in all_rows:
            if b != block:
                continue
            shown_range = (rng + (f" {unit}" if unit else "")) if rng else ""
            lines.append(f"| `{key}` | {cell(ctype)} | {('`' + cell(default) + '`') if default != '' else ''} | {shown_range} | {cell(doc)} |")
        lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


def main():
    text = render()
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != text:
            print("docs/configuration-reference.md is out of date: run python3 tools/gen_config_reference.py", file=sys.stderr)
            return 1
        return 0
    OUT.write_text(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
