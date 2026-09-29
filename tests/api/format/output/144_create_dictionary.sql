CREATE DICTIONARY IF NOT EXISTS anon.region_dict
(
    `region_key`  String,
    `region_name` String DEFAULT '',
    `parent_key`  String HIERARCHICAL
)
PRIMARY KEY region_key
SOURCE(CLICKHOUSE(TABLE 'regions' DB 'anon'))
LIFETIME(MIN 300 MAX 600)
LAYOUT(COMPLEX_KEY_HASHED())