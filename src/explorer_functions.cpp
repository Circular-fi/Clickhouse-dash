// The functions of the Explorer: the documentation and the structured fields of each function that the runner may call.
// The runner is the ClickHouse boundary of what it sees: a user-defined function is a function of the runner. The runner reads the fields.
// Then add the aliases that the documentation names (explorer_rules.hpp).
#include "explorer_catalog.hpp"

#include "explorer_rules.hpp"
#include "explorer_sql.hpp"
#include "explorer_values.hpp"

#include <string>
#include <string_view>
#include <unordered_map>

namespace chdash {

using namespace explorer;

bool load_explorer_functions(
    ChExecutor& runner,
    ExplorerFunctionsCatalog& out,
    std::string* error) {
  out = ExplorerFunctionsCatalog{};
  std::unordered_map<std::string, size_t> index_by_key;

  auto key_for = [](std::string_view kind, std::string_view name) {
    std::string key(kind);
    key.push_back('\0');
    key.append(name.data(), name.size());
    return key;
  };

  std::string documentation_error;
  const bool documentation_loaded = try_select(runner, function_documentation_sql(),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          ExplorerFunctionInfo item;
          item.name = block_string_at(block, 0, row);
          item.kind = block_string_at(block, 1, row);
          item.category = item.kind;
          item.description = block_string_at(block, 2, row);
          item.source = block_string_at(block, 3, row);
          item.origin = "System";
          if (item.name.empty()) continue;
          const std::string key = key_for(item.kind, item.name);
          if (index_by_key.emplace(key, out.functions.size()).second) {
            out.functions.push_back(std::move(item));
          }
        }
      }, &documentation_error);
  if (!documentation_loaded) {
    if (error) {
      *error = "Function documentation query failed: " +
          (documentation_error.empty() ? std::string("unknown ClickHouse error") : documentation_error);
    }
    return false;
  }
  out.documentation_available = true;

  // The 26.7 system.functions schema gives its documentation fields as Strings, not arrays.
  // The query reads every structured field. The UI then shows the syntax, the arguments, the return value and the examples as separate parts.
  // The system.documentation table stays the source of the complete Markdown body for the same version.
  // This query runs with runner_uri. UDF discovery then never becomes a metadata privilege escalation path.
  std::string functions_error;
  const bool functions_loaded = try_select(runner, function_list_sql(),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string name = block_string_at(block, 0, row);
          if (name.empty()) continue;
          const bool aggregate = truthy(block_string_at(block, 1, row));
          const std::string kind = aggregate ? "Aggregate Function" : "Function";
          const std::string key = key_for(kind, name);

          ExplorerFunctionInfo* item = nullptr;
          if (auto it = index_by_key.find(key); it != index_by_key.end()) {
            item = &out.functions[it->second];
          } else {
            ExplorerFunctionInfo created;
            created.name = name;
            created.kind = kind;
            index_by_key.emplace(key, out.functions.size());
            out.functions.push_back(std::move(created));
            item = &out.functions.back();
          }

          item->origin = block_string_at(block, 2, row);
          item->user_defined = item->origin != "System" && !item->origin.empty();
          const std::string create_query = block_string_at(block, 3, row);
          const std::string short_description = block_string_at(block, 4, row);
          item->syntax = block_string_at(block, 5, row);
          item->arguments = block_string_at(block, 6, row);
          item->parameters = block_string_at(block, 7, row);
          item->returned_value = block_string_at(block, 8, row);
          item->examples = block_string_at(block, 9, row);
          item->introduced_in = block_string_at(block, 10, row);
          item->category = block_string_at(block, 11, row);
          if (item->category.empty()) item->category = item->kind;

          // Built-in functions keep the richer Markdown from system.documentation.
          // UDFs generally have no embedded docs. If the runner exposes only the structured description or create query, use those.
          if (item->description.empty()) item->description = short_description;
          if (item->syntax.empty() && item->user_defined) item->syntax = create_query;
        }
      }, &functions_error);

  if (!functions_loaded) {
    if (error) {
      *error = "Function metadata query failed: " +
          (functions_error.empty() ? std::string("unknown ClickHouse error") : functions_error);
    }
    return false;
  }

  resolve_function_aliases(out);
  if (error) error->clear();
  return true;
}

}  // namespace chdash
