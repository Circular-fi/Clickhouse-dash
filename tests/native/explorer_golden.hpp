// Generated from the SQL that the code before the split of src/explorer_catalog.cpp, src/explorer_graph.cpp and src/api_explorer.cpp sent for the
// requests of the differential battery (the statements as they were sent, with each query parameter written in place as a quoted text): what the
// builders of src/explorer_sql.cpp must still write. @LIST@ stands for the list of names that a test chooses.
#pragma once

namespace golden {

// graph-logical [45]
inline constexpr const char* kBaseTablesOrdered =
    R"SQL(SELECT toString(database), toString(name), toString(engine), '', toString(sorting_key), toString(primary_key), toString(partition_key), toString(sampling_key), toString(storage_policy), toString(total_rows), toString(total_bytes), toString(total_bytes_uncompressed), arrayStringConcat(data_paths, char(31)), toString(metadata_modification_time), toString(toUInt8(metadata_modification_time >= now() - 2)) FROM system.tables WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') ORDER BY database, name)SQL";

// graph-logical [55]
inline constexpr const char* kDictionaries =
    R"SQL(SELECT toString(database), toString(name), toString(element_count), toString(bytes_allocated) FROM system.dictionaries)SQL";

// table-chdash_ui.station_dictionary_source [4]
inline constexpr const char* kTableRowCount =
    R"SQL(SELECT toString(count()) FROM `chdash_ui`.`station_dictionary_source`)SQL";

// graph-logical [57]
inline constexpr const char* kPartsSummary =
    R"SQL(SELECT toString(database), toString(`table`), toString(sum(rows)), toString(sum(bytes_on_disk)), toString(sum(data_compressed_bytes)), toString(sum(data_uncompressed_bytes)), toString(count()), toString(uniqExact(partition_id)), arrayStringConcat(arraySort(groupUniqArray(disk_name)), ','), toString(max(modification_time)), toString(sum(secondary_indices_compressed_bytes)) FROM system.parts WHERE active GROUP BY database, `table`)SQL";

// graph-logical [58]
inline constexpr const char* kProjectionBytes =
    R"SQL(SELECT toString(database), toString(`table`), toString(sum(data_compressed_bytes)) FROM system.projection_parts WHERE active GROUP BY database, `table`)SQL";

// graph-logical [59]
inline constexpr const char* kQueryIngress =
    R"SQL(SELECT toString(arrayJoin(tables)) AS object, toString(sumIf(written_rows, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), toString(sumIf(written_rows, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), toString(sum(written_rows) / 3600.0), toString(sumIf(written_bytes, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), toString(sumIf(written_bytes, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), toString(sum(written_bytes) / 3600.0), toString(sum(written_rows)), toString(sum(written_bytes)), toString(max(event_time)) FROM system.query_log WHERE event_date >= toDate(now() - INTERVAL 1 HOUR) AND event_time >= now() - INTERVAL 1 HOUR AND type = 'QueryFinish' AND written_rows > 0 GROUP BY object)SQL";

// graph-logical [60]
inline constexpr const char* kPartIngress =
    R"SQL(SELECT toString(database), toString(`table`), toString(sumIf(rows, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), toString(sumIf(rows, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), toString(sum(rows) / 3600.0), toString(sumIf(size_in_bytes, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), toString(sumIf(size_in_bytes, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), toString(sum(size_in_bytes) / 3600.0), toString(sum(rows)), toString(sum(size_in_bytes)), toString(countIf(event_time >= now() - INTERVAL 1 MINUTE)), toString(max(event_time)) FROM system.part_log WHERE event_date >= toDate(now() - INTERVAL 1 HOUR) AND event_time >= now() - INTERVAL 1 HOUR AND event_type = 'NewPart' GROUP BY database, `table`)SQL";

// graph-logical [61]
inline constexpr const char* kReplicas =
    R"SQL(SELECT toString(database), toString(`table`), toString(queue_size), toString(absolute_delay), toString(is_readonly), toString(is_session_expired), toString(replica_name), toString(zookeeper_path) FROM system.replicas)SQL";

// graph-logical [64]
inline constexpr const char* kPartsByDisk =
    R"SQL(SELECT toString(database), toString(disk_name), toString(sum(bytes_on_disk)) FROM system.parts WHERE active GROUP BY database, disk_name)SQL";

// catalog-chdash_repl [6]
inline constexpr const char* kDisksWithHost =
    R"SQL(SELECT toString(hostName()), toString(name), toString(path), toString(type), toString(free_space), toString(total_space) FROM system.disks)SQL";

// catalog-chdash_perf [3]
inline constexpr const char* kIndexTablesDb =
    R"SQL(SELECT toString(database), toString(name), toString(engine), toString(total_rows), toString(total_bytes), toString(metadata_modification_time) FROM system.tables WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') AND database = 'chdash_perf' ORDER BY database, name)SQL";

// catalog-chdash_perf [4]
inline constexpr const char* kDatabaseParts =
    R"SQL(SELECT toString(`table`), toString(sum(rows)), toString(sum(bytes_on_disk)), toString(sum(data_compressed_bytes)), toString(sum(data_uncompressed_bytes)), toString(count()), toString(max(modification_time)) FROM system.parts WHERE active AND database = 'chdash_perf' GROUP BY `table`)SQL";

// catalog-chdash_perf [5]
inline constexpr const char* kDatabaseDiskBytes =
    R"SQL(SELECT toString(disk_name), toString(sum(bytes_on_disk)) FROM system.parts WHERE active AND database = 'chdash_perf' GROUP BY disk_name ORDER BY disk_name)SQL";

// catalog-chdash_perf [6]
inline constexpr const char* kDatabaseReplicas =
    R"SQL(SELECT toString(`table`), toString(is_readonly), toString(is_session_expired), toString(queue_size), toString(absolute_delay) FROM system.replicas WHERE database = 'chdash_perf')SQL";

// catalog-root [12]
inline constexpr const char* kDatabaseTotals =
    R"SQL(SELECT toString(database), toString(count()), toString(sum(if(engine IN ('Buffer','Memory','Dictionary'), toUInt64(0), ifNull(total_rows, toUInt64(0))))), toString(sum(if(engine IN ('Buffer','Memory','Dictionary'), toUInt64(0), ifNull(total_bytes, toUInt64(0))))) FROM system.tables WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') GROUP BY database ORDER BY database)SQL";

// storage [45]
inline constexpr const char* kStorageParts =
    R"SQL(SELECT toString(database), toString(`table`), toString(sum(rows)), toString(sum(bytes_on_disk)), toString(count()) FROM system.parts WHERE active AND database IN (@LIST@) GROUP BY database, `table`)SQL";

// storage [46]
inline constexpr const char* kStorageTables =
    R"SQL(SELECT toString(database), toString(name), toString(engine), toString(total_rows), toString(total_bytes) FROM system.tables WHERE database IN (@LIST@))SQL";

// table-chdash_ui.weather_observations [3]
inline constexpr const char* kTableSummary =
    R"SQL(SELECT toString(database), toString(name), toString(engine), toString(engine_full), toString(sorting_key), toString(primary_key), toString(partition_key), toString(sampling_key), toString(storage_policy), toString(total_rows), toString(total_bytes), toString(total_bytes_uncompressed), arrayStringConcat(data_paths, char(31)), toString(metadata_modification_time) FROM system.tables WHERE database = 'chdash_ui' AND name = 'weather_observations' LIMIT 1)SQL";

// table-chdash_ui.weather_alert_buffer [4]
inline constexpr const char* kBufferTargetRows =
    R"SQL(SELECT toString(total_rows) FROM system.tables WHERE database = 'chdash_ui' AND name = 'weather_alert_target' LIMIT 1)SQL";

// table-chdash_ui.station_dictionary [4]
inline constexpr const char* kDictionarySize =
    R"SQL(SELECT toString(element_count), toString(bytes_allocated) FROM system.dictionaries WHERE database = 'chdash_ui' AND name = 'station_dictionary' LIMIT 1)SQL";

// table-chdash_ui.weather_observations [4]
inline constexpr const char* kTableParts =
    R"SQL(SELECT toString(sum(rows)), toString(sum(bytes_on_disk)), toString(sum(data_compressed_bytes)), toString(sum(data_uncompressed_bytes)), toString(count()), toString(uniqExact(partition_id)), arrayStringConcat(arraySort(groupUniqArray(disk_name)), ','), toString(max(modification_time)) FROM system.parts WHERE active AND database = 'chdash_ui' AND `table` = 'weather_observations')SQL";

// table-chdash_ui.weather_observations [5]
inline constexpr const char* kTableIndexBytes =
    R"SQL(SELECT toString(sum(secondary_indices_compressed_bytes)) FROM system.parts WHERE active AND database = 'chdash_ui' AND `table` = 'weather_observations')SQL";

// table-chdash_ui.weather_observations [6]
inline constexpr const char* kTableProjectionBytes =
    R"SQL(SELECT toString(sum(data_compressed_bytes)) FROM system.projection_parts WHERE active AND database = 'chdash_ui' AND `table` = 'weather_observations')SQL";

// table-chdash_ui.weather_observations [7]
inline constexpr const char* kTableQueryIngress =
    R"SQL(SELECT toString(sumIf(written_rows, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), toString(sumIf(written_rows, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), toString(sum(written_rows) / 3600.0), toString(sumIf(written_bytes, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), toString(sumIf(written_bytes, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), toString(sum(written_bytes) / 3600.0), toString(sum(written_rows)), toString(sum(written_bytes)), toString(max(event_time)) FROM system.query_log WHERE event_date >= toDate(now() - INTERVAL 1 HOUR) AND event_time >= now() - INTERVAL 1 HOUR AND type = 'QueryFinish' AND written_rows > 0 AND has(tables, 'chdash_ui.weather_observations'))SQL";

// table-chdash_ui.weather_observations [8]
inline constexpr const char* kTablePartIngress =
    R"SQL(SELECT toString(sumIf(rows, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), toString(sumIf(rows, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), toString(sum(rows) / 3600.0), toString(sumIf(size_in_bytes, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), toString(sumIf(size_in_bytes, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), toString(sum(size_in_bytes) / 3600.0), toString(sum(rows)), toString(sum(size_in_bytes)), toString(countIf(event_time >= now() - INTERVAL 1 MINUTE)), toString(max(event_time)) FROM system.part_log WHERE event_date >= toDate(now() - INTERVAL 1 HOUR) AND event_time >= now() - INTERVAL 1 HOUR AND event_type = 'NewPart' AND database = 'chdash_ui' AND `table` = 'weather_observations')SQL";

// table-chdash_repl.replicated_events [9]
inline constexpr const char* kTableReplicaDetail =
    R"SQL(SELECT toString(total_replicas), toString(active_replicas), toString(queue_size), toString(absolute_delay), toString(is_readonly), toString(is_session_expired), toString(replica_name), toString(zookeeper_path), toString(is_leader), toString(inserts_in_queue), toString(merges_in_queue), toString(log_max_index - least(log_pointer, log_max_index)), toString(last_queue_update), arrayStringConcat(arrayMap((name, active) -> concat(toString(active), name), mapKeys(replica_is_active), mapValues(replica_is_active)), char(31)) FROM system.replicas WHERE database = 'chdash_repl' AND `table` = 'replicated_events' LIMIT 1)SQL";

// table-chdash_ui.weather_observations [10]
inline constexpr const char* kTableDdl =
    R"SQL(SELECT toString(create_table_query) FROM system.tables WHERE database = 'chdash_ui' AND name = 'weather_observations' LIMIT 1)SQL";

// table-chdash_ui.weather_observations [11]
inline constexpr const char* kColumns =
    R"SQL(SELECT toString(name), toString(type), toString(default_kind), toString(default_expression), toString(compression_codec), toString(data_compressed_bytes), toString(data_uncompressed_bytes), toString(comment), toString(is_in_partition_key), toString(is_in_sorting_key), toString(is_in_primary_key), toString(is_in_sampling_key) FROM system.columns WHERE database = 'chdash_ui' AND `table` = 'weather_observations' ORDER BY position)SQL";

// table-chdash_ui.weather_observations [13]
inline constexpr const char* kDescribeSubcolumns =
    R"SQL(DESCRIBE TABLE `chdash_ui`.`weather_observations` SETTINGS describe_include_subcolumns = 1)SQL";

// data-chdash_ui.weather_observations [3]
inline constexpr const char* kDescribe =
    R"SQL(DESCRIBE TABLE `chdash_ui`.`weather_observations` SETTINGS describe_include_subcolumns = 0)SQL";

// table-chdash_ui.weather_observations [12]
inline constexpr const char* kDefaultCodecs =
    R"SQL(SELECT arrayStringConcat(arraySort(groupUniqArray(default_compression_codec)), char(31)) FROM system.parts WHERE active AND database = 'chdash_ui' AND `table` = 'weather_observations')SQL";

// table-chdash_ui.weather_observations [14]
inline constexpr const char* kPartTypes =
    R"SQL(SELECT toString(countIf(part_type = 'Compact')), toString(countIf(part_type = 'Wide')), toString(sumIf(bytes_on_disk, part_type = 'Compact')), toString(sumIf(bytes_on_disk, part_type = 'Wide')), toString(sumIf(data_compressed_bytes, part_type = 'Compact')), toString(sumIf(data_uncompressed_bytes, part_type = 'Compact')), toString(sumIf(data_compressed_bytes, part_type = 'Wide')), toString(sumIf(data_uncompressed_bytes, part_type = 'Wide')) FROM system.parts WHERE active AND database = 'chdash_ui' AND `table` = 'weather_observations')SQL";

// table-chdash_ui.weather_observations [15]
inline constexpr const char* kWideColumnSizes =
    R"SQL(SELECT toString(column), toString(sumIf(column_data_compressed_bytes, part_type = 'Wide')), toString(sumIf(column_data_uncompressed_bytes, part_type = 'Wide')) FROM system.parts_columns WHERE active AND database = 'chdash_ui' AND `table` = 'weather_observations' GROUP BY column ORDER BY column)SQL";

// table-chdash_ui.weather_observations [16]
inline constexpr const char* kWideSubcolumnSizes =
    R"SQL(SELECT toString(column), toString(tupleElement(sc, 1)), toString(sum(tupleElement(sc, 2))), toString(sum(tupleElement(sc, 3))) FROM (SELECT column, arrayJoin(arrayZip(subcolumns.names, subcolumns.data_compressed_bytes, subcolumns.data_uncompressed_bytes)) AS sc FROM system.parts_columns WHERE active AND part_type = 'Wide' AND database = 'chdash_ui' AND `table` = 'weather_observations') GROUP BY column, tupleElement(sc, 1) ORDER BY column, tupleElement(sc, 1))SQL";

// table-chdash_ui.weather_observations [17]
inline constexpr const char* kTableStorage =
    R"SQL(SELECT toString(disk_name), toString(sum(bytes_on_disk)), toString(sum(rows)), toString(count()) FROM system.parts WHERE active AND database = 'chdash_ui' AND `table` = 'weather_observations' GROUP BY disk_name ORDER BY disk_name)SQL";

// table-chdash_ui.station_dictionary_source [13]
inline constexpr const char* kDisks =
    R"SQL(SELECT toString(name), toString(path), toString(free_space), toString(total_space) FROM system.disks)SQL";

// table-chdash_ui.weather_observations [19]
inline constexpr const char* kPartList =
    R"SQL(SELECT toString(name), toString(partition), toString(disk_name), toString(rows), toString(bytes_on_disk), toString(marks), toString(files), toString(level), toString(dateDiff('second', modification_time, now())), toString(active) FROM system.parts WHERE database = 'chdash_ui' AND `table` = 'weather_observations' ORDER BY active DESC, modification_time DESC LIMIT 1000)SQL";

// table-chdash_ui.weather_observations [20]
inline constexpr const char* kPartitionList =
    R"SQL(SELECT toString(partition), toString(sum(rows)), toString(sum(bytes_on_disk)), toString(count()) FROM system.parts WHERE active AND database = 'chdash_ui' AND `table` = 'weather_observations' GROUP BY partition ORDER BY max(modification_time) DESC LIMIT 1000)SQL";

// table-chdash_ui.weather_observations [21]
inline constexpr const char* kSkippingIndices =
    R"SQL(SELECT toString(name), toString(type), toString(expr), toString(data_compressed_bytes), toString(data_uncompressed_bytes) FROM system.data_skipping_indices WHERE database = 'chdash_ui' AND `table` = 'weather_observations' ORDER BY name)SQL";

// table-chdash_ui.weather_observations [22]
inline constexpr const char* kProjections =
    R"SQL(SELECT toString(name), toString(type), toString(sorting_key) FROM system.projections WHERE database = 'chdash_ui' AND `table` = 'weather_observations' ORDER BY name)SQL";

// table-chdash_ui.weather_observations [23]
inline constexpr const char* kProjectionSizes =
    R"SQL(SELECT toString(name), toString(sum(data_compressed_bytes)), toString(sum(data_uncompressed_bytes)), toString(sum(bytes_on_disk)) FROM system.projection_parts WHERE active AND database = 'chdash_ui' AND `table` = 'weather_observations' GROUP BY name ORDER BY name)SQL";

// table-chdash_ui.weather_observations [24]
inline constexpr const char* kMutations =
    R"SQL(SELECT toString(mutation_id), toString(command), toString(create_time), toString(is_done), toString(parts_to_do), toString(latest_failed_part), toString(latest_fail_time), toString(latest_fail_reason) FROM system.mutations WHERE database = 'chdash_ui' AND `table` = 'weather_observations' ORDER BY create_time DESC LIMIT 100)SQL";

// table-chdash_ui.weather_observations [25]
inline constexpr const char* kMerges =
    R"SQL(SELECT toString(partition_id), toString(result_part_name), toString(elapsed), toString(progress), toString(num_parts), toString(rows_read), toString(bytes_read_uncompressed), toString(memory_usage) FROM system.merges WHERE database = 'chdash_ui' AND `table` = 'weather_observations' ORDER BY elapsed DESC)SQL";

// table-chdash_repl.replicated_events_all [19]
inline constexpr const char* kDistributionQueue =
    R"SQL(SELECT toString(data_path), toString(is_blocked), toString(error_count), toString(data_files), toString(data_compressed_bytes), toString(broken_data_files), toString(broken_data_compressed_bytes), toString(last_exception), toString(last_exception_time) FROM system.distribution_queue WHERE database = 'chdash_repl' AND `table` = 'replicated_events_all' ORDER BY error_count DESC, data_compressed_bytes DESC LIMIT 100)SQL";

// table-chdash_repl.replicated_events_all [20]
inline constexpr const char* kClusterTopology =
    R"SQL(SELECT toString(cluster), toString(shard_num), toString(replica_num), toString(host_name), toString(host_address), toString(port), toString(is_local), toString(errors_count), toString(slowdowns_count), toString(estimated_recovery_time) FROM system.clusters WHERE cluster = 'chdash_cluster' ORDER BY shard_num, replica_num)SQL";

// table-chdash_repl.replicated_daily [24]
inline constexpr const char* kReplicationQueue =
    R"SQL(SELECT toString(type), toString(create_time), toString(source_replica), toString(new_part_name), toString(num_tries), toString(last_attempt_time), toString(last_exception) FROM system.replication_queue WHERE database = 'chdash_repl' AND `table` = 'replicated_daily' ORDER BY create_time LIMIT 100)SQL";

// table-chdash_ui.weather_observations [26]
inline constexpr const char* kDownstream =
    R"SQL(SELECT toString(tupleElement(dep, 1)), toString(tupleElement(dep, 2)) FROM (SELECT arrayJoin(arrayZip(dependencies_database, dependencies_table)) AS dep FROM system.tables WHERE database = 'chdash_ui' AND name = 'weather_observations'))SQL";

// table-chdash_ui.memory_weather [20]
inline constexpr const char* kReverseLineage =
    R"SQL(SELECT toString(database), toString(name), toString(engine), if(engine = 'Buffer', toString(engine_full), ''), toString(as_select) FROM system.tables WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') AND engine IN ('Buffer', 'View', 'MaterializedView', 'LiveView', 'WindowView'))SQL";

// table-chdash_ui.weather_observations [32]
inline constexpr const char* kUpstream =
    R"SQL(SELECT toString(database), toString(name) FROM system.tables WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') AND has(dependencies_table, 'weather_observations') AND has(arrayZip(dependencies_database, dependencies_table), tuple('chdash_ui', 'weather_observations')))SQL";

// table-chdash_ui.mild_weather_observations [23]
inline constexpr const char* kDependencyEngines =
    R"SQL(SELECT toString(database), toString(name), toString(engine) FROM system.tables WHERE database IN ('chdash_ui') AND name IN (@LIST@))SQL";

// functions [0]
inline constexpr const char* kFunctionDocumentation =
    R"SQL(SELECT toString(name), toString(type), toString(description), toString(source) FROM system.documentation WHERE type IN ('Function', 'Aggregate Function', 'Table Function') ORDER BY type, name LIMIT 10000)SQL";

// functions [1]
inline constexpr const char* kFunctionList =
    R"SQL(SELECT toString(name), toString(is_aggregate), toString(origin), toString(create_query), toString(description), toString(syntax), toString(arguments), toString(parameters), toString(returned_value), toString(examples), toString(introduced_in), toString(categories) FROM system.functions ORDER BY name LIMIT 10000)SQL";

// data-chdash_ui.memory_weather [4]
inline constexpr const char* kPreviewMemory =
    R"SQL(SELECT `id`, `station_id` FROM `chdash_ui`.`memory_weather` LIMIT 7)SQL";

// data-chdash_ui.weather_daily_summary [4]
inline constexpr const char* kPreviewAggregate =
    R"SQL(SELECT `observation_date`, `city`, toString(finalizeAggregation(`observation_count`)) AS `observation_count`, toString(finalizeAggregation(`average_temperature`)) AS `average_temperature` FROM `chdash_ui`.`weather_daily_summary` LIMIT 7)SQL";

// graph-logical [65]
inline constexpr const char* kGraphDisks =
    R"SQL(SELECT toString(hostName()), toString(name), toString(path), toString(type), toString(free_space), toString(total_space) FROM system.disks ORDER BY name)SQL";

// graph-logical [66]
inline constexpr const char* kGraphStoragePolicies =
    R"SQL(SELECT toString(policy_name), toString(volume_name), toString(volume_priority), arrayStringConcat(disks, char(31)), toString(volume_type), toString(max_data_part_size), toString(move_factor) FROM system.storage_policies ORDER BY policy_name, volume_priority, volume_name)SQL";

// graph-logical [67]
inline constexpr const char* kGraphTables =
    R"SQL(SELECT toString(database), toString(name), toString(engine), arrayStringConcat(data_paths, char(31)), toString(metadata_modification_time), toString(toUInt8(metadata_modification_time >= now() - 2)) FROM system.tables)SQL";

// graph-logical [68]
inline constexpr const char* kGraphDependencies =
    R"SQL(SELECT toString(database), toString(name), toString(tupleElement(dep, 1)), toString(tupleElement(dep, 2)) FROM (SELECT toString(database) AS database, toString(name) AS name, arrayJoin(arrayZip(dependencies_database, dependencies_table)) AS dep FROM system.tables))SQL";

// graph-logical [69]
inline constexpr const char* kGraphDictionarySources =
    R"SQL(SELECT toString(database), toString(name), toString(tupleElement(dep, 1)), toString(tupleElement(dep, 2)) FROM (SELECT database, name, arrayJoin(arrayZip(loading_dependencies_database, loading_dependencies_table)) AS dep FROM system.tables WHERE engine = 'Dictionary'))SQL";

// graph-logical [70]
inline constexpr const char* kGraphClusters =
    R"SQL(SELECT toString(cluster), toString(shard_num), toString(replica_num), toString(host_name) FROM system.clusters ORDER BY cluster, shard_num, replica_num)SQL";

// graph-logical [71]
inline constexpr const char* kGraphRefreshProbe =
    R"SQL(SELECT toString(count() > 0) FROM system.tables WHERE database = 'system' AND name = 'view_refreshes')SQL";

}  // namespace golden
