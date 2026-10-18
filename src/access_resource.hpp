#pragma once

// The resources of the access of humans (docs/access.md, "Resources"; contract 11.4). A resource is a node of a tree under the
// service: the service, a host of the configuration under the service, and a database under a host. A question names the most
// specific node. Its ancestors give the chain from the service to the parent of the node.
// Pure code: no HTTP server and no PDP.

#include <string>
#include <string_view>
#include <vector>

namespace chdash {

// One node of the chain: a type and an id.
struct AccessNode {
  std::string type;
  std::string id;
};

struct AccessResource {
  std::string type;  // "service", "host" or "database"
  std::string id;
  // The chain from the service to the parent of the node. It is empty for the service.
  std::vector<AccessNode> ancestors;
};

// The service `service_id` (access.identity.audience).
AccessResource access_service_resource(const std::string& service_id);
// The host `host` of the configuration (the name of its clickhouse.host block), under the service.
AccessResource access_host_resource(const std::string& service_id, const std::string& host);
// The database `database` of the host `host`, under the service.
AccessResource access_database_resource(const std::string& service_id, const std::string& host, const std::string& database);

// True when `id` can be the id of a node: 1 to 256 bytes, valid UTF-8, and no control character.
bool access_valid_id(std::string_view id);

// The id in the encoded form of a segment (RFC 3986): each byte outside A-Z a-z 0-9 - . _ ~ becomes %XX (upper-case hex).
std::string access_encode_id(std::string_view id);

// The path of a resource: "service:<id>" and then "/<type>:<id>" for each node below the service, with the ids encoded. For
// example "service:db/host:prod/database:analytics". The log line access.decision and the key of the cache use it.
std::string access_resource_path(const AccessResource& resource);

// The host of a resource: the id of the host node, in the resource or in its ancestors. Empty for the service.
std::string access_resource_host(const AccessResource& resource);

} // namespace chdash
