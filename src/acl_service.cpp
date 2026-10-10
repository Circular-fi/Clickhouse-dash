#include "acl_service.hpp"

#include "ch_client_pool.hpp"
#include "ch_uri.hpp"
#include "jwt.hpp"

#include <algorithm>
#include <exception>
#include <utility>

namespace chdash {
namespace {

template <typename Value>
typename TtlCache<std::string, Value>::Options cache_options(const AclService::Options& options,
                                                             std::function<size_t(const Value&)> bytes) {
  typename TtlCache<std::string, Value>::Options out;
  out.ttl = options.ttl;
  out.stale_for = options.stale_for;
  out.failure_backoff = options.failure_backoff;
  out.wait = options.wait;
  // A grant may have been revoked: an ACL that cannot be read again is not answered from memory.
  out.serve_stale_on_error = false;
  out.max_entries = options.max_entries;
  out.max_bytes = options.max_bytes;
  out.value_bytes = std::move(bytes);
  out.submit = options.submit;
  return out;
}

// The prefix of every key of an identity: invalidate() drops them all at once.
std::string scope_of(const AclAccess& access) {
  std::string key = access.key;
  key.push_back('\0');
  return key;
}

std::unique_ptr<AclSource> connect_or_fail(const AclAccess& access, std::string& code, std::string& message) {
  std::string error;
  auto source = access.connect ? access.connect(&error) : nullptr;
  if (!source) {
    code = "runner_unavailable";
    message = error.empty() ? "Cannot connect to ClickHouse to read the privileges of the runner." : error;
  }
  return source;
}

void append_issues(std::vector<AclIssue>& to, const std::vector<AclIssue>& from) {
  constexpr size_t kMaxIssues = 64;
  for (const auto& issue : from) {
    if (to.size() >= kMaxIssues) return;
    to.push_back(issue);
  }
}

} // namespace

std::string acl_identity_key(const std::string& uri) {
  return sha256_hex(uri);
}

AclAccess make_acl_access(const std::shared_ptr<ClickHouseClientPool>& pool, const std::string& uri) {
  AclAccess access;
  access.key = acl_identity_key(uri);
  access.connect = [pool, uri](std::string* error) -> std::unique_ptr<AclSource> {
    auto client = pool ? pool->acquire(uri, std::chrono::seconds(5), std::chrono::seconds(15), std::chrono::seconds(15), error)
                       : make_client_from_uri(uri, std::chrono::seconds(5), std::chrono::seconds(15), std::chrono::seconds(15), error);
    if (!client) return nullptr;
    return make_acl_source(std::move(client), pool);
  };
  return access;
}

size_t AclTableSet::approx_bytes() const {
  size_t bytes = sizeof(*this) + allowed.approx_bytes();
  for (const auto& name : unverified_databases) bytes += sizeof(std::string) + name.size();
  for (const auto& issue : issues) bytes += sizeof(AclIssue) + issue.database.size() + issue.object.size() + issue.message.size();
  return bytes;
}

AclService::AclService(Options options)
    : options_(std::move(options)),
      databases_(cache_options<AclDatabases>(options_, [](const AclDatabases& value) { return value.approx_bytes(); })),
      objects_(cache_options<AclObjects>(options_, [](const AclObjects& value) { return value.approx_bytes(); })),
      readable_(cache_options<bool>(options_, [](const bool&) { return sizeof(bool); })),
      sets_(cache_options<AclTableSet>(options_, [](const AclTableSet& value) { return value.approx_bytes(); })) {}

template <typename Value>
std::shared_ptr<const Value> AclService::answer(const typename TtlCache<std::string, Value>::Result& result) {
  if (result.has_value && result.value && !result.had_error) return result.value;
  if (result.exception) {
    try {
      std::rethrow_exception(result.exception);
    } catch (const AclUnavailable&) {
      throw;
    } catch (const std::exception& error) {
      throw AclUnavailable("acl_unavailable", error.what());
    }
  }
  throw AclUnavailable(result.error_code.empty() ? "acl_unavailable" : result.error_code,
                       result.error_message.empty() ? "The privileges of the runner could not be read." : result.error_message);
}

AclBudget AclService::budget() const {
  AclBudget out;
  out.max_objects = options_.max_objects;
  out.max_objects_per_database = options_.max_objects_per_database;
  out.deadline = std::chrono::steady_clock::now() + options_.discovery_time;
  return out;
}

std::shared_ptr<const AclDatabases> AclService::databases(const AclAccess& access) {
  const auto result = databases_.get_revalidating(scope_of(access), [this, access](AclDatabases& value, std::string& code, std::string& message) {
    auto source = connect_or_fail(access, code, message);
    if (!source) return false;
    AclBudget limits = budget();
    value = discover_databases(*source, limits);
    return true;
  });
  return answer<AclDatabases>(result);
}

std::shared_ptr<const AclObjects> AclService::objects(const AclAccess& access, const std::string& database) {
  const auto result = objects_.get_revalidating(scope_of(access) + database, [this, access, database](AclObjects& value, std::string& code, std::string& message) {
    auto source = connect_or_fail(access, code, message);
    if (!source) return false;
    AclBudget limits = budget();
    value = discover_objects(*source, database, limits);
    return true;
  });
  return answer<AclObjects>(result);
}

bool AclService::table_readable(const AclAccess& access, const std::string& database, const std::string& table) {
  if (!explorer_schema_visible(database) || database.empty() || table.empty()) return false;
  std::string key = scope_of(access) + database;
  key.push_back('\0');
  key += table;
  const auto result = readable_.get_revalidating(key, [access, database, table](bool& value, std::string& code, std::string& message) {
    auto source = connect_or_fail(access, code, message);
    if (!source) return false;
    try {
      value = check_table_access(*source, database, table).has_value();
    } catch (const AclObjectError&) {
      // ClickHouse could not answer about this object (it may be gone): it is not shown.
      value = false;
    }
    return true;
  });
  return *answer<bool>(result);
}

std::shared_ptr<const AclTableSet> AclService::table_set(const AclAccess& access) {
  const auto result = sets_.get_revalidating(scope_of(access), [this, access](AclTableSet& value, std::string&, std::string&) {
    const auto deadline = std::chrono::steady_clock::now() + options_.discovery_time;
    const auto listed = databases(access);
    value.truncated = listed->truncated;
    value.unverified_databases = listed->unverified;
    append_issues(value.issues, listed->issues);
    for (const auto& database : listed->databases) {
      if (std::chrono::steady_clock::now() >= deadline) {
        value.truncated = true;
        value.unverified_databases.push_back(database);
        continue;
      }
      const auto readable = objects(access, database);
      for (const auto& object : readable->objects) value.allowed.add_table(object);
      value.truncated = value.truncated || readable->truncated;
      append_issues(value.issues, readable->issues);
    }
    return true;
  });
  return answer<AclTableSet>(result);
}

void AclService::invalidate(const AclAccess& access) {
  const std::string prefix = scope_of(access);
  databases_.invalidate_prefix(prefix);
  objects_.invalidate_prefix(prefix);
  readable_.invalidate_prefix(prefix);
  sets_.invalidate_prefix(prefix);
}

void AclService::invalidate(const AclAccess& access, const std::string& database) {
  const std::string prefix = scope_of(access);
  objects_.invalidate(prefix + database);
  std::string readable_prefix = prefix + database;
  readable_prefix.push_back('\0');
  readable_.invalidate_prefix(readable_prefix);
  sets_.invalidate(prefix);
}

const std::vector<std::string>& AclView::databases() {
  if (!databases_) databases_ = service_.databases(access_);
  return databases_->databases;
}

bool AclView::database_visible(const std::string& database) {
  const auto& names = databases();
  return std::binary_search(names.begin(), names.end(), database);
}

const AclObjects& AclView::objects(const std::string& database) {
  auto it = objects_.find(database);
  if (it == objects_.end()) {
    std::shared_ptr<const AclObjects> listed;
    if (database_visible(database)) listed = service_.objects(access_, database);
    else listed = std::make_shared<const AclObjects>();
    it = objects_.emplace(database, std::move(listed)).first;
  }
  return *it->second;
}

bool AclView::visible(const std::string& database, const std::string& table) {
  return objects(database).contains(table);
}

bool AclView::readable(const std::string& database, const std::string& table) {
  const auto it = objects_.find(database);
  if (it != objects_.end()) return it->second->contains(table);
  return service_.table_readable(access_, database, table);
}

bool AclView::truncated() {
  databases();
  if (databases_->truncated) return true;
  for (const auto& item : objects_) {
    if (item.second->truncated) return true;
  }
  return false;
}

} // namespace chdash
