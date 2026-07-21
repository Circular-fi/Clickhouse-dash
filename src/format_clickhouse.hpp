#pragma once

#include <cstddef>
#include <optional>
#include <string>

namespace clickhouse { class Client; }

namespace chdash {

struct HostSpec;

std::optional<std::string> try_format_query_with_client(
    clickhouse::Client& client,
    const std::string& sql,
    size_t max_bytes,
    std::string* err_log
);

std::optional<std::string> try_format_query(
    const HostSpec& host,
    const std::string& sql,
    size_t max_bytes,
    std::string* err_log
);

} // namespace chdash
