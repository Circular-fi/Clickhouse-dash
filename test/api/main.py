import sys

import pytest


if __name__ == "__main__":
    raise SystemExit(pytest.main(["-q", "/tests/format/check_format.py"]))
