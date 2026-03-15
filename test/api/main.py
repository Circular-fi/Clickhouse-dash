import sys

import pytest

from format.check_format import update_sql_raw_from_clickhouse


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "test"

    if mode == "test":
        return pytest.main(["-q", "/tests/format/check_format.py"])

    if mode == "update-raw":
        return update_sql_raw_from_clickhouse()

    raise SystemExit(f"unknown mode: {mode}")


if __name__ == "__main__":
    raise SystemExit(main())
