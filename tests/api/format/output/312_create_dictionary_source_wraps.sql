-- service names resolved from the catalogue table
CREATE DICTIONARY IF NOT EXISTS service_catalog_dict
(
    `service_id`   UInt64,
    `service_name` String DEFAULT 'unknown',
    `owner_team`   String
)
PRIMARY KEY service_id
SOURCE(CLICKHOUSE(
    HOST 'localhost'
    PORT 9000
    USER 'default'
    TABLE 'service_catalog_source'
    DB currentDatabase()
))
LIFETIME(MIN 300 MAX 600)
LAYOUT(HASHED())