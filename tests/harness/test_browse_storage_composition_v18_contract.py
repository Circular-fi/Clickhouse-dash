from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_storage_composition_reconciles_to_bytes_on_disk() -> None:
    ui = read("src/static/app_explorer.js")
    assert "function storageComposition(detail)" in ui
    assert "const baseBytes = footprint - structureBytes;" in ui
    assert "wideBytes = baseBytes * (rawWide / rawBase);" in ui
    assert "compactBytes = baseBytes - wideBytes;" in ui
    assert "Math.max(0, 100 - consumed)" in ui
    assert 'bar.appendChild(node("span", "explorerStorageStackedBar__unknown", "unknown"));' in ui


def test_storage_composition_uses_parent_part_on_disk_split() -> None:
    catalog = read("src/explorer_catalog.cpp")
    header = read("src/explorer_catalog.hpp")
    api = read("src/api_explorer.cpp")
    assert "sumIf(bytes_on_disk, part_type = 'Compact')" in catalog
    assert "sumIf(bytes_on_disk, part_type = 'Wide')" in catalog
    assert "compact_on_disk_bytes" in header
    assert "wide_on_disk_bytes" in header
    assert 'w.Key("compact_on_disk_bytes")' in api
    assert 'w.Key("wide_on_disk_bytes")' in api


def test_projection_composition_uses_projection_footprint_not_only_compressed_data() -> None:
    catalog = read("src/explorer_catalog.cpp")
    header = read("src/explorer_catalog.hpp")
    api = read("src/api_explorer.cpp")
    ui = read("src/static/app_explorer.js")
    assert "toString(sum(bytes_on_disk)) FROM system.projection_parts" in catalog
    assert "std::optional<uint64_t> on_disk_bytes;" in header
    assert 'w.Key("on_disk_bytes")' in api
    assert 'structureOnDiskBytes(detail, "projection:")' in ui
