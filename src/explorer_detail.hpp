#pragma once

// The card of one table of the Explorer, read in sections. load_explorer_table_detail (explorer_detail.cpp) runs them in this order; each
// reads the statements of explorer_sql.hpp, as the system account and, where that account fails, as the runner (the object has passed the
// runner's ACL already), and a section that cannot be read for want of a grant is left out of the card and named in its unavailable_sections.
// The sections of the lineage and of the scope totals are in explorer_lineage.cpp.

#include "acl_service.hpp"
#include "explorer_catalog.hpp"

#include <map>
#include <string>
#include <tuple>

namespace chdash {
namespace explorer {

class TableDetailReader {
 public:
  TableDetailReader(ChExecutor& system, ChExecutor& runner, AclView& acl, const AllowedObjectSet& allowed, const std::string& database,
                    const std::string& table, const ExplorerTableSummary& summary, ExplorerTableDetail& out, std::string* error)
      : system_(system), runner_(runner), acl_(acl), allowed_(allowed), database_(database), table_(table), summary_(summary), out_(out),
        error_(error) {}

  // Each returns false when the card cannot be made: *error says why.
  bool read_definition();           // the DDL, its TTL, the targets of a Distributed table
  bool read_columns();              // the columns, their codecs and TTLs, the subcolumns of the tuples
  bool read_column_storage();       // compact and wide parts, the size of each wide column
  bool read_storage();              // the disks of the table and their capacity
  bool read_parts();                // the parts and the partitions
  bool read_indexes_and_projections();
  bool read_mutations_and_merges();
  bool read_distributed();          // the distribution queue and the topology of the cluster
  bool read_replication_queue();
  bool read_lineage();              // what the table reads from and what reads it (explorer_lineage.cpp)
  void read_footprint();            // the bytes of its database and of the server, for the shares of the card (explorer_lineage.cpp)

 private:
  // `section` is degraded (named in the card, with the grant to give) when the error is a missing grant; false when it is another error.
  bool degrade(const char* section, const std::string& section_error);
  bool fail(const std::string& message);
  void append_dependency(const std::string& database, const std::string& table, const char* relation, const char* kind = "dependency");
  bool lineage_visible(const std::string& database, const std::string& table);

  ChExecutor& system_;
  ChExecutor& runner_;
  AclView& acl_;
  const AllowedObjectSet& allowed_;
  const std::string& database_;
  const std::string& table_;
  const ExplorerTableSummary& summary_;
  ExplorerTableDetail& out_;
  std::string* error_;

  std::string section_error_;
  // The part types of the table (read_column_storage), for the shares of each wide column.
  uint64_t compact_parts_ = 0, wide_parts_ = 0, wide_compressed_ = 0;
  bool storage_loaded_ = false;
  // The lineage: a neighbour is listed once for each relation, and a neighbour that the runner may not read is not listed.
  bool lineage_acl_failed_ = false;
  std::map<std::tuple<std::string, std::string, std::string>, size_t> dependency_seen_;
};

}  // namespace explorer
}  // namespace chdash
