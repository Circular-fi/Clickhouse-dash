import sys

import pytest


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "test"

    if mode == "test":
        return pytest.main(
            [
                "-q",
                "/tests/api/format/check_format.py",
                "/tests/api/meta/check_meta.py",
                "/tests/api/query_types/check_query_types.py",
            ]
        )

    raise SystemExit(f"unknown mode: {mode}")


if __name__ == "__main__":
    raise SystemExit(main())
