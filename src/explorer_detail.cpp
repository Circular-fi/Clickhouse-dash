#include "explorer_detail.hpp"

#include "explorer_rules.hpp"
#include "explorer_sql.hpp"
#include "explorer_values.hpp"
#include "sql_structure.hpp"
#include "time_util.hpp"

#include <algorithm>
#include <stdexcept>
#include <unordered_map>

namespace chdash {

using namespace explorer;

namespace explorer {

bool TableDetailReader::degrade(const char* section, const std::string& section_error) {
  return degrade_on_denied(section, section_error, out_);
}

bool TableDetailReader::fail(const std::string& message) {
  if (error_) *error_ = message;
  return false;
}

bool TableDetailReader::read_definition() {
  if (!allowed_.allows_table(database_, table_) || summary_.database != database_ || summary_.name != table_) return fail("object not found");

  out_ = ExplorerTableDetail{};
  out_.summary = summary_;

  section_error_.clear();
  const SqlStatement ddl_sql = table_ddl_sql(database_, table_);
  auto load_ddl = [&](ChExecutor& db, std::string* load_error) {
    return try_select(db, ddl_sql,
      [&](const clickhouse::Block& block) {
        if (block.GetRowCount() == 0 || block.GetColumnCount() == 0) return;
        out_.create_table_query = block_string_at(block, 0, 0);
      }, load_error);
  };
  bool table_loaded = load_ddl(system_, &section_error_);
  if (!table_loaded || out_.create_table_query.empty()) {
    // The metadata of each object can be read through runner_uri after the ACL boundary accepted this exact object. This also
    // covers newly created tables that the technical metadata connection cannot see yet.
    out_.create_table_query.clear();
    std::string runner_error;
    table_loaded = load_ddl(runner_, &runner_error);
    if (!table_loaded || out_.create_table_query.empty()) {
      return fail("DDL metadata query failed for " + database_ + "." + table_ + (runner_error.empty() ? std::string{} : ": " + runner_error));
    }
  }
  out_.table_ttl = sql::table_ttl_clause(out_.create_table_query);
  if (summary_.engine == "Distributed") {
    const auto args = sql::engine_arguments(summary_.engine_full, "Distributed");
    if (!args.empty()) out_.distributed_cluster = args[0];
    if (args.size() >= 3) {
      out_.distributed_database = resolve_buffer_database_arg(args[1], database_);
      out_.distributed_table = args[2];
    }
  }
  return true;
}

bool TableDetailReader::read_columns() {
  section_error_.clear();
  const SqlStatement columns_statement = columns_sql(database_, table_);
  auto load_columns = [&](ChExecutor& db, std::string* load_error) {
    return try_select(db, columns_statement,
      [&](const clickhouse::Block& block) {
        constexpr size_t kExpectedColumns = 12;
        if (block.GetRowCount() > 0 && block.GetColumnCount() < kExpectedColumns) {
          throw std::runtime_error(
              "system.columns metadata block has " + std::to_string(block.GetColumnCount()) +
              " columns; expected at least " + std::to_string(kExpectedColumns) + ".");
        }
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string name = block_string_at(block, 0, row);
          if (!allowed_.allows_column(database_, table_, name)) continue;
          ExplorerColumnInfo column;
          column.name = name;
          column.type = block_string_at(block, 1, row);
          column.default_kind = block_string_at(block, 2, row);
          column.default_expression = block_string_at(block, 3, row);
          column.codec_expression = block_string_at(block, 4, row);
          column.compressed_bytes = parse_u64(block_string_at(block, 5, row));
          column.uncompressed_bytes = parse_u64(block_string_at(block, 6, row));
          column.comment = block_string_at(block, 7, row);
          column.in_partition_key = truthy(block_string_at(block, 8, row));
          column.in_sorting_key = truthy(block_string_at(block, 9, row));
          column.in_primary_key = truthy(block_string_at(block, 10, row));
          column.in_sampling_key = truthy(block_string_at(block, 11, row));
          out_.columns.push_back(std::move(column));
        }
      }, load_error);
  };

  bool columns_loaded = load_columns(system_, &section_error_);
  if (!columns_loaded || out_.columns.empty()) {
    out_.columns.clear();
    std::string runner_error;
    columns_loaded = load_columns(runner_, &runner_error);
    if (!columns_loaded) return fail("Column metadata query failed: " + runner_error);
  }

  // Since ClickHouse 24.2, parameterized View objects have no rows in system.columns on purpose. Use DESCRIBE as a fallback
  // for any object whose catalog columns are absent. Ordinary tables and views are then read. The ACL boundary stays intact.
  // A parameterized view can also reject a bare DESCRIBE, because its parameters were not supplied. The Explorer still has
  // useful object metadata (DDL, lineage, engine). A View without a static schema must stay browsable. It must not turn an
  // upstream ClickHouse metadata limitation into a 503.
  if (out_.columns.empty()) {
    const SqlStatement fallback_describe_sql = describe_sql(database_, table_, false);
    auto load_describe_columns = [&](ChExecutor& db, std::string* load_error) {
      return try_select(db, fallback_describe_sql,
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) {
            if (block.GetColumnCount() < 2) continue;
            const std::string name = block_string_at(block, 0, row);
            if (name.empty() || !allowed_.allows_column(database_, table_, name)) continue;
            ExplorerColumnInfo column;
            column.name = name;
            column.type = block_string_at(block, 1, row);
            if (block.GetColumnCount() > 2) column.default_kind = block_string_at(block, 2, row);
            if (block.GetColumnCount() > 3) column.default_expression = block_string_at(block, 3, row);
            if (block.GetColumnCount() > 4) column.comment = block_string_at(block, 4, row);
            if (block.GetColumnCount() > 5) column.codec_expression = block_string_at(block, 5, row);
            if (block.GetColumnCount() > 6) column.ttl_expression = block_string_at(block, 6, row);
            out_.columns.push_back(std::move(column));
          }
        }, load_error);
    };

    std::string describe_fallback_error;
    const bool fallback_loaded = load_describe_columns(system_, &describe_fallback_error);
    if (!fallback_loaded || out_.columns.empty()) {
      out_.columns.clear();
      std::string runner_describe_error;
      load_describe_columns(runner_, &runner_describe_error);
    }
  }

  const bool schema_unresolved_view = out_.columns.empty() && (summary_.engine == "View" || summary_.engine == "MaterializedView");
  if (out_.columns.empty() && !schema_unresolved_view) {
    return fail("Column metadata query returned no readable columns for " + database_ + "." + table_);
  }
  if (schema_unresolved_view) out_.unavailable_sections.push_back("columns");

  // system.columns.compression_codec is empty on purpose when a column has no explicit CODEC(). For MergeTree, the Explorer can still show
  // the codec that ClickHouse used for these columns. It reads the default codec recorded on the active parts. This is more useful than the
  // unclear UI label "server default". It also shows the right codec for tables whose old and new parts use different defaults after a settings or
  // compression-policy change.
  if (summary_.engine.find("MergeTree") != std::string::npos) {
    std::string codec_error;
    (void)try_select(system_, default_codecs_sql(database_, table_),
      [&](const clickhouse::Block& block) {
        if (!block.GetRowCount() || !block.GetColumnCount()) return;
        out_.default_compression_codecs = split_unit_separator(block_string_at(block, 0, 0));
        out_.default_compression_codecs.erase(
          std::remove_if(out_.default_compression_codecs.begin(), out_.default_compression_codecs.end(),
            [](const std::string& value) { return value.empty(); }),
          out_.default_compression_codecs.end());
      }, &codec_error);
  }

  if (!out_.columns.empty()) {
    // DESCRIBE TABLE only reads metadata and stays stable across versions for column TTLs. Include subcolumns, so the Browse storage breakdown can
    // show named Tuple fields (for example `<sensor_packet.station.code>`) and not hide all tuple storage behind the parent column.
    // The runner ACL still applies at the top-level column boundary. A subcolumn is visible only when its longest matching top-level
    // parent is readable.
    std::unordered_map<std::string, ExplorerColumnInfo*> columns_by_name;
    columns_by_name.reserve(out_.columns.size());
    for (auto& column : out_.columns) columns_by_name.emplace(column.name, &column);
    std::vector<ExplorerColumnInfo> described_subcolumns;
    section_error_.clear();
    const SqlStatement describe_statement = describe_sql(database_, table_, true);
    auto load_describe = [&](ChExecutor& db, std::string* load_error) {
      return try_select(db, describe_statement,
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) {
            if (block.GetColumnCount() < 7) continue;
            const std::string name = block_string_at(block, 0, row);
            const bool is_subcolumn = block.GetColumnCount() >= 8 && block_bool_at(block, 7, row);
            if (!is_subcolumn) {
              const auto it = columns_by_name.find(name);
              if (it == columns_by_name.end()) continue;
              auto& column = *it->second;
              const std::string described_codec = block_string_at(block, 5, row);
              const std::string described_ttl = block_string_at(block, 6, row);
              if (column.codec_expression.empty() && !described_codec.empty()) column.codec_expression = described_codec;
              column.ttl_expression = described_ttl;
              continue;
            }

            ExplorerColumnInfo* parent = nullptr;
            size_t parent_length = 0;
            for (auto& candidate : out_.columns) {
              const std::string prefix = candidate.name + ".";
              if (name.size() <= prefix.size() || name.compare(0, prefix.size(), prefix) != 0) continue;
              if (candidate.name.size() > parent_length) {
                parent = &candidate;
                parent_length = candidate.name.size();
              }
            }
            if (!parent || parent->type.find("Tuple(") == std::string::npos) continue;

            ExplorerColumnInfo subcolumn;
            subcolumn.name = name;
            subcolumn.type = block_string_at(block, 1, row);
            // Intermediate Tuple subcolumns are structural containers. They do not own a physical stream in MergeTree parts. Their display
            // produces a misleading size row with no bytes. Keep only the leaf tuple fields that system.parts_columns can account for.
            if (subcolumn.type.rfind("Tuple(", 0) == 0 || subcolumn.type.rfind("NamedTuple(", 0) == 0) continue;
            subcolumn.default_kind = block_string_at(block, 2, row);
            subcolumn.default_expression = block_string_at(block, 3, row);
            subcolumn.codec_expression = block_string_at(block, 5, row);
            if (subcolumn.codec_expression.empty()) subcolumn.codec_expression = parent->codec_expression;
            subcolumn.ttl_expression = block_string_at(block, 6, row);
            subcolumn.is_subcolumn = true;
            subcolumn.parent_name = parent->name;
            described_subcolumns.push_back(std::move(subcolumn));
          }
        }, load_error);
    };

    bool describe_loaded = load_describe(system_, &section_error_);
    if (!describe_loaded) {
      described_subcolumns.clear();
      for (auto& column : out_.columns) column.ttl_expression.clear();
      std::string runner_error;
      describe_loaded = load_describe(runner_, &runner_error);
      if (!describe_loaded) return fail("Column DESCRIBE metadata query failed: " + runner_error);
    }

    if (!described_subcolumns.empty()) {
      std::vector<ExplorerColumnInfo> ordered;
      ordered.reserve(out_.columns.size() + described_subcolumns.size());
      for (auto& column : out_.columns) {
        const std::string parent_name = column.name;
        ordered.push_back(std::move(column));
        for (auto& subcolumn : described_subcolumns) {
          if (subcolumn.parent_name == parent_name) ordered.push_back(std::move(subcolumn));
        }
      }
      out_.columns = std::move(ordered);
    }
  }
  return true;
}

bool TableDetailReader::read_column_storage() {
  // Compact parts store all columns in one data file. ClickHouse reports column_data_* = 0 for these parts,
  // including in system.parts_columns. Exact per-column Compact compressed bytes therefore do not exist as metadata. Keep the exact
  // table and part-type totals from system.parts. Use system.parts_columns only for the independently stored Wide portion. This avoids
  // both a user-data scan and invented allocations.
  uint64_t compact_on_disk = 0;
  uint64_t wide_on_disk = 0;
  uint64_t compact_compressed = 0;
  uint64_t compact_uncompressed = 0;
  uint64_t wide_uncompressed = 0;
  section_error_.clear();
  const bool column_part_types_loaded = try_select(system_, part_types_sql(database_, table_),
    [&](const clickhouse::Block& block) {
      if (!block.GetRowCount()) return;
      compact_parts_ = parse_u64(block_string_at(block, 0, 0)).value_or(0);
      wide_parts_ = parse_u64(block_string_at(block, 1, 0)).value_or(0);
      compact_on_disk = parse_u64(block_string_at(block, 2, 0)).value_or(0);
      wide_on_disk = parse_u64(block_string_at(block, 3, 0)).value_or(0);
      compact_compressed = parse_u64(block_string_at(block, 4, 0)).value_or(0);
      compact_uncompressed = parse_u64(block_string_at(block, 5, 0)).value_or(0);
      wide_compressed_ = parse_u64(block_string_at(block, 6, 0)).value_or(0);
      wide_uncompressed = parse_u64(block_string_at(block, 7, 0)).value_or(0);
    }, &section_error_);
  if (!column_part_types_loaded) {
    if (!degrade("column_storage_format", section_error_)) return fail("Column storage-format query failed: " + section_error_);
  }

  out_.column_storage.compact_parts = compact_parts_;
  out_.column_storage.wide_parts = wide_parts_;
  if (compact_parts_ > 0) {
    out_.column_storage.compact_on_disk_bytes = compact_on_disk;
    out_.column_storage.compact_compressed_bytes = compact_compressed;
    out_.column_storage.compact_uncompressed_bytes = compact_uncompressed;
  }
  if (wide_parts_ > 0) {
    out_.column_storage.wide_on_disk_bytes = wide_on_disk;
    out_.column_storage.wide_compressed_bytes = wide_compressed_;
    out_.column_storage.wide_uncompressed_bytes = wide_uncompressed;
  }

  if (compact_parts_ > 0 || wide_parts_ > 0) {
    // system.columns aggregates the same counters, but it does not distinguish the part format. Rebuild the per-column size metrics from
    // system.parts_columns. Then mixed tables clearly mean "Wide bytes" and do not silently exclude Compact.
    for (auto& column : out_.columns) {
      column.compressed_bytes.reset();
      column.uncompressed_bytes.reset();
      column.relative_weight.reset();
    }

    if (wide_parts_ > 0) {
      std::unordered_map<std::string, ExplorerColumnInfo*> column_by_name;
      std::unordered_map<std::string, ExplorerColumnInfo*> subcolumn_by_name;
      column_by_name.reserve(out_.columns.size());
      subcolumn_by_name.reserve(out_.columns.size());
      for (auto& column : out_.columns) {
        if (column.is_subcolumn) subcolumn_by_name.emplace(column.name, &column);
        else column_by_name.emplace(column.name, &column);
      }

      bool saw_wide_column = false;
      section_error_.clear();
      const bool wide_column_sizes_loaded = try_select(system_, wide_column_sizes_sql(database_, table_),
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) {
            const std::string name = block_string_at(block, 0, row);
            const auto it = column_by_name.find(name);
            if (it == column_by_name.end()) continue;
            const auto compressed = parse_u64(block_string_at(block, 1, row));
            const auto uncompressed = parse_u64(block_string_at(block, 2, row));
            if (!compressed || !uncompressed) continue;
            it->second->compressed_bytes = compressed;
            it->second->uncompressed_bytes = uncompressed;
            saw_wide_column = true;
          }
        }, &section_error_);
      if (!wide_column_sizes_loaded) {
        out_.unavailable_sections.push_back("wide_column_sizes");
      } else if (!saw_wide_column && wide_compressed_ > 0) {
        out_.unavailable_sections.push_back("wide_column_sizes");
      }

      // Modern MergeTree parts give exact nested-stream counters in the `subcolumns.*` arrays. Aggregate them by the DESCRIBE-visible dot
      // path, so that named Tuple fields can be compared without a read of user data.
      if (!subcolumn_by_name.empty()) {
        section_error_.clear();
        const bool wide_subcolumn_sizes_loaded = try_select(system_, wide_subcolumn_sizes_sql(database_, table_),
          [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) {
              const std::string parent = block_string_at(block, 0, row);
              const std::string relative = block_string_at(block, 1, row);
              const auto it = subcolumn_by_name.find(parent + "." + relative);
              if (it == subcolumn_by_name.end()) continue;
              const auto compressed = parse_u64(block_string_at(block, 2, row));
              const auto uncompressed = parse_u64(block_string_at(block, 3, row));
              if (compressed) it->second->compressed_bytes = compressed;
              if (uncompressed) it->second->uncompressed_bytes = uncompressed;
            }
          }, &section_error_);
        if (!wide_subcolumn_sizes_loaded) out_.unavailable_sections.push_back("wide_subcolumn_sizes");
      }
    }

    // The relative weight always uses the exact Wide data total. Top-level Tuple rows and their subcolumn rows overlap on purpose.
    // The sum of the visible rows counts nested storage twice.
    if (wide_compressed_ > 0) {
      for (auto& column : out_.columns) {
        if (column.compressed_bytes) {
          column.relative_weight = static_cast<double>(*column.compressed_bytes) / static_cast<double>(wide_compressed_);
        }
      }
    }

    if (compact_parts_ > 0 && wide_parts_ == 0) {
      out_.unavailable_sections.push_back("column_sizes_compact_shared");
    } else if (compact_parts_ > 0) {
      out_.unavailable_sections.push_back("column_sizes_mixed_shared");
    }
  }
  return true;
}

bool TableDetailReader::read_storage() {
  storage_loaded_ = try_select(system_, table_storage_sql(database_, table_),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerStorageDisk disk;
        disk.disk = block_string_at(block, 0, row);
        disk.bytes = parse_u64(block_string_at(block, 1, row));
        disk.rows = parse_u64(block_string_at(block, 2, row));
        disk.parts = parse_u64(block_string_at(block, 3, row)).value_or(0);
        out_.storage.push_back(std::move(disk));
      }
    }, &section_error_);
  if (!storage_loaded_) {
    if (!degrade("storage", section_error_)) return fail("Storage metadata query failed: " + section_error_);
  }

  // TinyLog, Log and StripeLog are persistent disk engines. They create no MergeTree parts, so system.parts is empty. Resolve their
  // system.tables.data_paths against system.disks. Show the physical placement. Do not invent parts. When a table spans more than
  // one disk, ClickHouse gives no per-path byte split here. Leave the per-disk bytes unknown. Do not copy the table total to every disk.
  if (out_.storage.empty() && is_log_family(summary_.engine) && !summary_.data_paths.empty()) {
    struct DiskMeta {
      std::string name;
      std::string path;
      std::optional<uint64_t> free_space;
      std::optional<uint64_t> total_space;
    };
    std::vector<DiskMeta> disks;
    section_error_.clear();
    const bool disks_loaded = try_select(system_, disks_sql(),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          disks.push_back({
            block_string_at(block, 0, row),
            block_string_at(block, 1, row),
            parse_u64(block_string_at(block, 2, row)),
            parse_u64(block_string_at(block, 3, row)),
          });
        }
      }, &section_error_);
    if (!disks_loaded) {
      if (!degrade("log_engine_disk", section_error_)) return fail("Log-engine disk metadata query failed: " + section_error_);
    }

    std::map<std::string, DiskMeta> matched;
    for (const auto& data_path : summary_.data_paths) {
      const std::string best = disk_of_path(data_path, [&](auto&& visit) {
        for (const auto& disk : disks) visit(disk.name, disk.path);
      });
      if (best.empty()) continue;
      for (const auto& disk : disks) {
        if (disk.name == best) {
          matched.emplace(best, disk);
          break;
        }
      }
    }

    const bool exact_single_disk = matched.size() == 1;
    for (const auto& [name, disk_meta] : matched) {
      ExplorerStorageDisk disk;
      disk.disk = name;
      disk.path = disk_meta.path;
      disk.free_space = disk_meta.free_space;
      disk.total_space = disk_meta.total_space;
      if (exact_single_disk) {
        disk.bytes = summary_.logical_bytes;
        disk.rows = summary_.rows;
      }
      disk.parts = 0;
      out_.storage.push_back(std::move(disk));
    }
  }
  if (storage_loaded_ && !out_.storage.empty()) {
    // system.disks is queried once. Only the disk names that are already linked to this allowed table are shown to the caller. This prevents
    // unrelated infrastructure metadata from being exposed through a table detail request.
    std::unordered_map<std::string, ExplorerStorageDisk*> storage_by_name;
    for (auto& disk : out_.storage) storage_by_name.emplace(disk.disk, &disk);
    const bool disks_loaded = try_select(system_, disks_sql(),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const auto it = storage_by_name.find(block_string_at(block, 0, row));
          if (it == storage_by_name.end()) continue;
          it->second->path = block_string_at(block, 1, row);
          it->second->free_space = parse_u64(block_string_at(block, 2, row));
          it->second->total_space = parse_u64(block_string_at(block, 3, row));
        }
      }, &section_error_);
    if (!disks_loaded) {
      if (!degrade("disk_capacity", section_error_)) return fail("Disk capacity query failed: " + section_error_);
    }
  }
  return true;
}

bool TableDetailReader::read_parts() {
  const bool parts_loaded = try_select(system_, part_list_sql(database_, table_),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerPartInfo part;
        part.name = block_string_at(block, 0, row);
        part.partition = block_string_at(block, 1, row);
        part.disk = block_string_at(block, 2, row);
        part.rows = parse_u64(block_string_at(block, 3, row)).value_or(0);
        part.bytes = parse_u64(block_string_at(block, 4, row)).value_or(0);
        part.marks = parse_u64(block_string_at(block, 5, row)).value_or(0);
        part.files = parse_u64(block_string_at(block, 6, row)).value_or(0);
        part.level = parse_u64(block_string_at(block, 7, row)).value_or(0);
        part.age_seconds = parse_u64(block_string_at(block, 8, row)).value_or(0);
        part.active = truthy(block_string_at(block, 9, row));
        out_.parts.push_back(std::move(part));
      }
    }, &section_error_);
  if (!parts_loaded) {
    if (!degrade("parts", section_error_)) return fail("Parts metadata query failed: " + section_error_);
  }

  const bool partitions_loaded = try_select(system_, partition_list_sql(database_, table_),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerPartitionInfo partition;
        partition.partition = block_string_at(block, 0, row);
        partition.rows = parse_u64(block_string_at(block, 1, row)).value_or(0);
        partition.bytes = parse_u64(block_string_at(block, 2, row)).value_or(0);
        partition.parts = parse_u64(block_string_at(block, 3, row)).value_or(0);
        out_.partitions.push_back(std::move(partition));
      }
    }, &section_error_);
  if (!partitions_loaded) {
    if (!degrade("partitions", section_error_)) return fail("Partitions metadata query failed: " + section_error_);
  }
  return true;
}

bool TableDetailReader::read_indexes_and_projections() {
  const bool indexes_loaded = try_select(system_, skipping_indices_sql(database_, table_),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerIndexProjectionInfo item;
        item.name = block_string_at(block, 0, row);
        item.kind = "index:" + block_string_at(block, 1, row);
        item.expression = block_string_at(block, 2, row);
        item.compressed_bytes = parse_u64(block_string_at(block, 3, row));
        item.uncompressed_bytes = parse_u64(block_string_at(block, 4, row));
        out_.indexes_and_projections.push_back(std::move(item));
      }
    }, &section_error_);
  if (!indexes_loaded) {
    if (!degrade("skipping_index", section_error_)) return fail("Skipping-index metadata query failed: " + section_error_);
  }

  const bool projections_loaded = try_select(system_, projections_sql(database_, table_),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerIndexProjectionInfo item;
        item.name = block_string_at(block, 0, row);
        item.kind = "projection:" + block_string_at(block, 1, row);
        item.expression = block_string_at(block, 2, row);
        out_.indexes_and_projections.push_back(std::move(item));
      }
    }, &section_error_);
  if (!projections_loaded) {
    if (!degrade("projection", section_error_)) return fail("Projection metadata query failed: " + section_error_);
  }

  // system.projections describes the definition. The materialized storage is in system.projection_parts. Enrich each projection with
  // its exact local compressed data size, so that Browse can compare it to columns and indexes.
  section_error_.clear();
  const bool projection_sizes_loaded = try_select(system_, projection_sizes_sql(database_, table_),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string name = block_string_at(block, 0, row);
        const auto compressed = parse_u64(block_string_at(block, 1, row));
        const auto uncompressed = parse_u64(block_string_at(block, 2, row));
        const auto on_disk = parse_u64(block_string_at(block, 3, row));
        for (auto& item : out_.indexes_and_projections) {
          if (item.name == name && item.kind.rfind("projection:", 0) == 0) {
            item.compressed_bytes = compressed;
            item.uncompressed_bytes = uncompressed;
            item.on_disk_bytes = on_disk;
            break;
          }
        }
      }
    }, &section_error_);
  if (!projection_sizes_loaded) out_.unavailable_sections.push_back("projection_sizes");
  return true;
}

bool TableDetailReader::read_mutations_and_merges() {
  const bool mutation_loaded = try_select(system_, mutations_sql(database_, table_),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerMutationInfo mutation;
        mutation.mutation_id = block_string_at(block, 0, row);
        mutation.command = block_string_at(block, 1, row);
        mutation.create_time = block_string_at(block, 2, row);
        mutation.done = truthy(block_string_at(block, 3, row));
        mutation.parts_to_do = parse_u64(block_string_at(block, 4, row)).value_or(0);
        mutation.latest_failed_part = block_string_at(block, 5, row);
        mutation.latest_fail_time = block_string_at(block, 6, row);
        mutation.latest_fail_reason = block_string_at(block, 7, row);
        out_.mutations.push_back(std::move(mutation));
      }
    }, &section_error_);
  if (!mutation_loaded) {
    if (!degrade("mutation", section_error_)) return fail("Mutation metadata query failed: " + section_error_);
  }

  const bool merges_loaded = try_select(system_, merges_sql(database_, table_),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerMergeInfo merge;
        merge.partition = block_string_at(block, 0, row);
        merge.result_part_name = block_string_at(block, 1, row);
        merge.elapsed_seconds = parse_double(block_string_at(block, 2, row)).value_or(0);
        merge.progress = parse_double(block_string_at(block, 3, row)).value_or(0);
        merge.num_parts = parse_u64(block_string_at(block, 4, row)).value_or(0);
        merge.rows_read = parse_u64(block_string_at(block, 5, row)).value_or(0);
        merge.bytes_read = parse_u64(block_string_at(block, 6, row)).value_or(0);
        merge.memory_usage = parse_u64(block_string_at(block, 7, row)).value_or(0);
        out_.merges.push_back(std::move(merge));
      }
    }, &section_error_);
  if (!merges_loaded) {
    if (!degrade("merge", section_error_)) return fail("Merge metadata query failed: " + section_error_);
  }
  return true;
}

bool TableDetailReader::read_distributed() {
  if (out_.summary.engine != "Distributed") return true;
  const bool distribution_queue_loaded = try_select(system_, distribution_queue_sql(database_, table_),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerDistributionQueueItem item;
        item.data_path = block_string_at(block, 0, row);
        item.blocked = truthy(block_string_at(block, 1, row));
        item.error_count = parse_u64(block_string_at(block, 2, row)).value_or(0);
        item.data_files = parse_u64(block_string_at(block, 3, row)).value_or(0);
        item.data_compressed_bytes = parse_u64(block_string_at(block, 4, row)).value_or(0);
        item.broken_data_files = parse_u64(block_string_at(block, 5, row)).value_or(0);
        item.broken_data_compressed_bytes = parse_u64(block_string_at(block, 6, row)).value_or(0);
        item.last_exception = block_string_at(block, 7, row);
        item.last_exception_time = block_string_at(block, 8, row);
        out_.distribution_queue.push_back(std::move(item));
      }
    }, &section_error_);
  if (!distribution_queue_loaded) {
    if (!degrade("distribution_queue", section_error_)) return fail("Distribution queue query failed: " + section_error_);
  }

  if (!out_.distributed_cluster.empty()) {
    const bool topology_loaded = try_select(system_, cluster_topology_sql(out_.distributed_cluster),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          ExplorerTopologyNode node;
          node.cluster = block_string_at(block, 0, row);
          node.shard_num = parse_u64(block_string_at(block, 1, row)).value_or(0);
          node.replica_num = parse_u64(block_string_at(block, 2, row)).value_or(0);
          node.host_name = block_string_at(block, 3, row);
          node.host_address = block_string_at(block, 4, row);
          node.port = parse_u64(block_string_at(block, 5, row)).value_or(0);
          node.is_local = truthy(block_string_at(block, 6, row));
          node.errors_count = parse_u64(block_string_at(block, 7, row)).value_or(0);
          node.slowdowns_count = parse_u64(block_string_at(block, 8, row)).value_or(0);
          node.estimated_recovery_time = parse_u64(block_string_at(block, 9, row)).value_or(0);
          out_.topology.push_back(std::move(node));
        }
      }, &section_error_);
    if (!topology_loaded) {
      if (!degrade("distributed_topology", section_error_)) return fail("Distributed topology query failed: " + section_error_);
    }
  } else {
    out_.unavailable_sections.push_back("topology");
  }
  return true;
}

bool TableDetailReader::read_replication_queue() {
  if (!out_.summary.replication.available) return true;
  const bool queue_loaded = try_select(system_, replication_queue_sql(database_, table_),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerReplicationQueueItem item;
        item.type = block_string_at(block, 0, row);
        item.create_time = block_string_at(block, 1, row);
        item.source_replica = block_string_at(block, 2, row);
        item.new_part_name = block_string_at(block, 3, row);
        item.num_tries = parse_u64(block_string_at(block, 4, row)).value_or(0);
        item.last_attempt_time = block_string_at(block, 5, row);
        item.last_exception = block_string_at(block, 6, row);
        out_.replication_queue.push_back(std::move(item));
      }
    }, &section_error_);
  if (!queue_loaded) {
    if (!degrade("replication_queue", section_error_)) return fail("Replication queue query failed: " + section_error_);
  }
  return true;
}

}  // namespace explorer

bool load_explorer_table_detail(
    ChExecutor& system,
    ChExecutor& runner,
    AclView& acl,
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    const ExplorerTableSummary& summary,
    ExplorerTableDetail& out,
    std::string* error) {
  explorer::TableDetailReader reader(system, runner, acl, allowed, database, table, summary, out, error);
  return reader.read_definition() && reader.read_columns() && reader.read_column_storage() && reader.read_storage() && reader.read_parts() &&
         reader.read_indexes_and_projections() && reader.read_mutations_and_merges() && reader.read_distributed() &&
         reader.read_replication_queue() && reader.read_lineage() && (reader.read_footprint(), true);
}

}  // namespace chdash
