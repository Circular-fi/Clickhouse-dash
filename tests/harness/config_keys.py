"""The rows of the table of configuration keys (src/config_keys.def), for the tests that check a key and its bounds."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))

import gen_config_reference as _tool  # noqa: E402


def _rows():
    out = {}
    for line in _tool.DEF.read_text().splitlines():
        import re

        m = re.match(r"^CFG_(INT|BOOL|STRING|ENUM)\((.*)\)\s*$", line)
        if not m:
            continue
        kind, body = m.groups()
        args = _tool.split_arguments(body)
        block, key = _tool.unquote(args[0]), _tool.unquote(args[1])
        row = {"kind": kind, "block": block, "key": key}
        if kind == "INT":
            row.update(ctype=args[2], field=args[3], default=_tool.unquote(args[4]), min=int(args[5]), max=int(args[6]),
                       zero=args[7] == "true", unit=_tool.unquote(args[8]))
        elif kind in ("BOOL", "STRING"):
            row.update(field=args[2], default=_tool.unquote(args[3]))
        else:
            row.update(field=args[2], default=_tool.unquote(args[3]), choices=_tool.unquote(args[4]).split("|"))
        out[(block, key)] = row
    return out


ROWS = _rows()


def row(block, key):
    """The row of `block.key`; a test that names a key that is not in the table fails here."""
    assert (block, key) in ROWS, f"{block}.{key} is not in src/config_keys.def"
    return ROWS[(block, key)]


def bounds(block, key):
    """(min, max) of an integer key."""
    r = row(block, key)
    return r["min"], r["max"]
