cmake_minimum_required(VERSION 3.20)
project(chdash LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(CHDASH_EMBED_STATIC "Embed src/static into the chdash binary" ON)
option(CHDASH_BUILD_APP "Build chdash executable" ON)
option(CHDASH_BUILD_CODEC_TESTS "Build the processor JSON codec test driver" OFF)
option(CHDASH_BUILD_QUERY_LIBRARY_TESTS "Build the query library store unit tests" OFF)
option(CHDASH_BUILD_MCP_TESTS "Build the MCP unit tests (scopes, keys, SQL, protocol, tools, config)" OFF)
option(CHDASH_BUILD_SYSTEM_TESTS "Build the System page SQL builder unit tests" OFF)
option(CHDASH_BUILD_RESULT_TESTS "Build the result path unit tests (JSON cell encoder, block encoder)" OFF)
option(CHDASH_BUILD_FORMAT_TESTS "Build the bound tests of the JSON parse and the SQL formatter (small thread stacks)" OFF)
option(CHDASH_BUILD_CH_QUERY_TESTS "Build the tests of the ClickHouse statements and connections (a server is optional)" OFF)
option(CHDASH_BUILD_CACHE_TESTS "Build the unit tests of the caches and of the ACL discovery (fakes, no ClickHouse needed)" OFF)
option(CHDASH_BUILD_REQUEST_TESTS "Build the unit tests of the way a request is served: admission, the request context, the routes in the process" OFF)
option(CHDASH_BUILD_ERROR_TESTS "Build the unit tests of the error answer: the envelope, the classification of ClickHouse failures" OFF)
option(CHDASH_BUILD_CONFIG_TESTS "Build the unit tests of the configuration file: the table of keys, the bounds, the URIs, the HCL parser" OFF)
option(CHDASH_BUILD_SQL_TESTS "Build the unit tests of the SQL text: literals, lexer, policy, structure" OFF)
option(CHDASH_BUILD_EXPLORER_TESTS "Build the unit tests of the Explorer: the SQL, the rules, the readers on a fake executor, the TTL, the graph (no ClickHouse needed)" OFF)
option(CHDASH_BUILD_LOGS_TESTS "Build the unit tests of the Logs page below its routes: the filters, the statements, the patterns and the service on a fake executor (no ClickHouse needed)" OFF)
option(CHDASH_BUILD_METRICS_TESTS "Build the unit tests of the Metrics page: the request, the SQL, the aggregation of the rows, the service (a fake executor, no ClickHouse needed)" OFF)
option(CHDASH_BUILD_TRACE_TESTS "Build the unit tests of the Traces page: the request, the filters, the SQL, the search strategies (a fake executor, no ClickHouse needed)" OFF)
option(CHDASH_BUILD_FUZZERS "Build the libFuzzer targets of tests/fuzz (clang only)" OFF)

set(CHDASH_SEMVER_VALUE "dev" CACHE STRING "Semantic version embedded in the binary")
set(CHDASH_GIT_SHA_VALUE "unknown" CACHE STRING "Git SHA embedded in the binary")
set(CHDASH_BUILD_TIME_VALUE "unknown" CACHE STRING "Build time embedded in the binary")

include(${CMAKE_CURRENT_LIST_DIR}/BuildFlags.cmake)
include(FetchContent)

set(RAPIDJSON_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(RAPIDJSON_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(RAPIDJSON_BUILD_DOC OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)

# Every dependency is pinned by commit: a tag can move. Dependabot does not see FetchContent, so a bump
# is a manual change of the SHA (and of its comment).
FetchContent_Declare(
  clickhouse_cpp
  GIT_REPOSITORY https://github.com/ClickHouse/clickhouse-cpp.git
  GIT_TAG        001025cd72d904104c15657e85e0fb6b0ec58e14 # v2.6.2
)
# A Bool is a ColumnBool (true, false), not a UInt8: the JSON encoder, the export and the type of a result say Bool.
set(CH_MAP_BOOL_TO_UINT8 OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(clickhouse_cpp)

FetchContent_Declare(
  httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG        9d6a7ee2c1aaeb1fd9ae15d14f06f487149d147f # v0.54.1
)
FetchContent_MakeAvailable(httplib)

FetchContent_Declare(
  rapidjson
  GIT_REPOSITORY https://github.com/Tencent/rapidjson.git
  GIT_TAG        24b5e7a8b27f42fa16b96fc70aade9106cf7102f # master, 2025-02
  # GenericStringRef declares a copy assignment that it never defines (older revisions assign a const
  # member, which GCC 14 refuses). The patch step writes "= delete" for every toolchain (PatchRapidJSON.cmake).
  PATCH_COMMAND  ${CMAKE_COMMAND} -P ${CMAKE_CURRENT_LIST_DIR}/PatchRapidJSON.cmake
)
FetchContent_MakeAvailable(rapidjson)

if (CHDASH_BUILD_CODEC_TESTS)
  add_executable(chdash_processor_codec_test ../tests/native/processor_json_driver.cpp)
  target_include_directories(chdash_processor_codec_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_processor_codec_test SYSTEM PRIVATE ${rapidjson_SOURCE_DIR}/include)
  chdash_configure_target(chdash_processor_codec_test)
endif()

# The query library: the store, the file format, the rules of the tree, the import, the reading of a request.
set(CHDASH_QUERY_LIBRARY_SOURCES query_library.cpp query_library_file.cpp query_library_import.cpp query_library_request.cpp query_library_rules.cpp)

if (CHDASH_BUILD_QUERY_LIBRARY_TESTS)
  add_executable(chdash_query_library_test ../tests/native/query_library_test.cpp ${CHDASH_QUERY_LIBRARY_SOURCES} error_envelope.cpp secure_random.cpp log.cpp)
  target_include_directories(chdash_query_library_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_query_library_test SYSTEM PRIVATE ${rapidjson_SOURCE_DIR}/include)
  chdash_configure_target(chdash_query_library_test)
endif()

if (CHDASH_BUILD_MCP_TESTS)
  # Scopes, keys and their file, the SQL scanner and builder, the protocol and the tools with fakes,
  # and the startup errors of the mcp { } block (no ClickHouse server needed). Also the HTTP hardening
  # (the guard of the writes, the page policy, the asset versions), the random source and the log lines.
  add_executable(chdash_mcp_test ../tests/native/mcp_test.cpp
    mcp_scope.cpp mcp_identity.cpp mcp_grants.cpp mcp_api_tools.cpp mcp_keys.cpp mcp_sql.cpp mcp_protocol.cpp mcp_tools.cpp
    error_envelope.cpp request_context.cpp config.cpp config_schema.cpp hcl.cpp ch_uri.cpp ${CHDASH_QUERY_LIBRARY_SOURCES} ch_query.cpp jwt.cpp secure_random.cpp log.cpp http_guard.cpp metrics.cpp health_runner.cpp)
  target_include_directories(chdash_mcp_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_mcp_test SYSTEM PRIVATE ${clickhouse_cpp_SOURCE_DIR} ${httplib_SOURCE_DIR} ${rapidjson_SOURCE_DIR}/include)
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_mcp_test PRIVATE clickhouse-cpp-lib Threads::Threads)
  chdash_configure_target(chdash_mcp_test)
endif()

if (CHDASH_BUILD_RESULT_TESTS)
  # The path of a result to the browser: the JSON cell encoder (Query page, exports, MCP rows) and the
  # thread that encodes the blocks (no ClickHouse needed).
  add_executable(chdash_result_path_test ../tests/native/result_path_test.cpp)
  target_include_directories(chdash_result_path_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_result_path_test SYSTEM PRIVATE ${clickhouse_cpp_SOURCE_DIR} ${rapidjson_SOURCE_DIR}/include)
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_result_path_test PRIVATE clickhouse-cpp-lib Threads::Threads)
  chdash_configure_target(chdash_result_path_test)
endif()

if (CHDASH_BUILD_EXPLORER_TESTS)
  # The Explorer below its routes: the statements, the rules on the rows, the readers of the catalog, the sidebar, the storage map, the card of a
  # table, the functions and the preview on a fake executor, the TTL, and the graph.
  add_executable(chdash_explorer_test ../tests/native/explorer_test.cpp
    explorer_catalog.cpp explorer_detail.cpp explorer_functions.cpp explorer_graph.cpp explorer_graph_build.cpp explorer_graph_scope.cpp explorer_index.cpp explorer_json.cpp explorer_lineage.cpp
    explorer_preview.cpp explorer_replicas.cpp explorer_rules.cpp explorer_service.cpp explorer_sql.cpp explorer_storage.cpp explorer_table.cpp explorer_ttl.cpp
    sql_structure.cpp acl_service.cpp allowed_objects.cpp
    ch_query.cpp ch_client_pool.cpp ch_uri.cpp ch_error.cpp api_error.cpp error_envelope.cpp request_context.cpp log.cpp jwt.cpp secure_random.cpp)
  target_include_directories(chdash_explorer_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_explorer_test SYSTEM PRIVATE ${clickhouse_cpp_SOURCE_DIR} ${httplib_SOURCE_DIR} ${rapidjson_SOURCE_DIR}/include)
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_explorer_test PRIVATE clickhouse-cpp-lib Threads::Threads)
  chdash_configure_target(chdash_explorer_test)
endif()

if (CHDASH_BUILD_LOGS_TESTS)
  # The Logs page below its routes: the text search, the patterns, the parsing of a request, the filters, the statements, and the service
  # on a fake executor with its JSON.
  add_executable(chdash_logs_test ../tests/native/logs_test.cpp
    logs_text.cpp logs_drain.cpp logs_patterns.cpp logs_request.cpp logs_filters.cpp logs_sql.cpp logs_service.cpp logs_json.cpp allowed_objects.cpp
    ch_query.cpp ch_client_pool.cpp ch_uri.cpp ch_error.cpp api_error.cpp error_envelope.cpp request_context.cpp log.cpp jwt.cpp secure_random.cpp)
  target_include_directories(chdash_logs_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_logs_test SYSTEM PRIVATE ${clickhouse_cpp_SOURCE_DIR} ${httplib_SOURCE_DIR} ${rapidjson_SOURCE_DIR}/include)
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_logs_test PRIVATE clickhouse-cpp-lib Threads::Threads)
  chdash_configure_target(chdash_logs_test)
endif()

if (CHDASH_BUILD_METRICS_TESTS)
  # The Metrics page below its routes: the parsing of a request, the statements, the aggregation of the rows, and the service on a fake
  # executor with its JSON.
  add_executable(chdash_metrics_test ../tests/native/metrics_test.cpp
    metrics_aggregate.cpp metrics_json.cpp metrics_request.cpp metrics_service.cpp metrics_sql.cpp allowed_objects.cpp
    ch_query.cpp ch_client_pool.cpp ch_uri.cpp ch_error.cpp api_error.cpp error_envelope.cpp request_context.cpp log.cpp jwt.cpp secure_random.cpp)
  target_include_directories(chdash_metrics_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_metrics_test SYSTEM PRIVATE ${clickhouse_cpp_SOURCE_DIR} ${httplib_SOURCE_DIR} ${rapidjson_SOURCE_DIR}/include)
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_metrics_test PRIVATE clickhouse-cpp-lib Threads::Threads)
  chdash_configure_target(chdash_metrics_test)
endif()

if (CHDASH_BUILD_FORMAT_TESTS)
  # The bounded JSON parse and the depth guard of the formatter, on 128 KiB thread stacks (no ClickHouse needed).
  add_executable(chdash_format_depth_test ../tests/native/format_depth_test.cpp format_postprocess.cpp)
  target_include_directories(chdash_format_depth_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_format_depth_test SYSTEM PRIVATE ${rapidjson_SOURCE_DIR}/include)
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_format_depth_test PRIVATE Threads::Threads)
  chdash_configure_target(chdash_format_depth_test)
endif()

if (CHDASH_BUILD_CH_QUERY_TESTS)
  # The settings of a statement, its scope, and the state of its connection; the cases that need a server
  # run when CHDASH_TEST_CLICKHOUSE_URI names one.
  add_executable(chdash_ch_query_test ../tests/native/ch_query_test.cpp ch_query.cpp ch_client_pool.cpp ch_uri.cpp)
  target_include_directories(chdash_ch_query_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_ch_query_test SYSTEM PRIVATE ${clickhouse_cpp_SOURCE_DIR})
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_ch_query_test PRIVATE clickhouse-cpp-lib Threads::Threads)
  chdash_configure_target(chdash_ch_query_test)
endif()

if (CHDASH_BUILD_CACHE_TESTS)
  # TtlCache, the ACL discovery and AclService, DdlTextCache and FormatCache, with a fake clock and a fake identity.
  add_executable(chdash_cache_acl_test ../tests/native/cache_acl_test.cpp
    acl_service.cpp allowed_objects.cpp ch_query.cpp ch_client_pool.cpp ch_uri.cpp jwt.cpp format_cache.cpp)
  target_include_directories(chdash_cache_acl_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_cache_acl_test SYSTEM PRIVATE ${clickhouse_cpp_SOURCE_DIR} ${rapidjson_SOURCE_DIR}/include)
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_cache_acl_test PRIVATE clickhouse-cpp-lib Threads::Threads)
  chdash_configure_target(chdash_cache_acl_test)
endif()

if (CHDASH_BUILD_ERROR_TESTS)
  # The one error answer: the JSON envelope, the classification of a ClickHouse failure by its code, the answer of each kind.
  add_executable(chdash_error_test ../tests/native/error_test.cpp api_error.cpp error_envelope.cpp ch_error.cpp ch_query.cpp
    ch_client_pool.cpp ch_uri.cpp)
  target_include_directories(chdash_error_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_error_test SYSTEM PRIVATE ${clickhouse_cpp_SOURCE_DIR} ${httplib_SOURCE_DIR} ${rapidjson_SOURCE_DIR}/include)
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_error_test PRIVATE clickhouse-cpp-lib Threads::Threads)
  chdash_configure_target(chdash_error_test)
endif()

if (CHDASH_BUILD_REQUEST_TESTS)
  # The way a request is served: admission, the context of a request, the routes that are also callable in the process.
  add_executable(chdash_request_test ../tests/native/request_test.cpp request_context.cpp ch_query.cpp deep_analysis_jobs.cpp export_job.cpp)
  target_include_directories(chdash_request_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_request_test SYSTEM PRIVATE ${clickhouse_cpp_SOURCE_DIR} ${httplib_SOURCE_DIR} ${rapidjson_SOURCE_DIR}/include)
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_request_test PRIVATE clickhouse-cpp-lib Threads::Threads)
  chdash_configure_target(chdash_request_test)
endif()

if (CHDASH_BUILD_CONFIG_TESTS)
  # The configuration file: the table of keys and their bounds, the errors, the derived values, the URIs, the HCL parser.
  add_executable(chdash_config_test ../tests/native/config_test.cpp
    config.cpp config_schema.cpp hcl.cpp ch_uri.cpp ch_query.cpp error_envelope.cpp mcp_keys.cpp mcp_scope.cpp mcp_api_tools.cpp mcp_identity.cpp ${CHDASH_QUERY_LIBRARY_SOURCES} jwt.cpp
    secure_random.cpp log.cpp health_runner.cpp ch_client_pool.cpp)
  target_include_directories(chdash_config_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_config_test SYSTEM PRIVATE ${clickhouse_cpp_SOURCE_DIR} ${httplib_SOURCE_DIR} ${rapidjson_SOURCE_DIR}/include)
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_config_test PRIVATE clickhouse-cpp-lib Threads::Threads)
  chdash_configure_target(chdash_config_test)
endif()

if (CHDASH_BUILD_SQL_TESTS)
  # The text of a statement: what is written into it, how it is read (the one lexer), and what is read from it.
  # The two WebAssembly kernels that read SQL are built natively next to it (tests/native/wasm_kernel_*.c): the test runs
  # them and the lexer on one corpus.
  enable_language(C)
  add_executable(chdash_sql_test ../tests/native/sql_test.cpp ../tests/native/wasm_kernel_highlight.c ../tests/native/wasm_kernel_sqlscan.c
    sql_structure.cpp user_sql_policy.cpp mcp_sql.cpp format_service.cpp format_postprocess.cpp format_cache.cpp jwt.cpp secure_random.cpp)
  target_link_libraries(chdash_sql_test PRIVATE m)
  target_include_directories(chdash_sql_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_sql_test SYSTEM PRIVATE ${rapidjson_SOURCE_DIR}/include)
  chdash_configure_target(chdash_sql_test)
endif()

if (CHDASH_BUILD_TRACE_TESTS)
  # The Traces page below its routes: the parsing of a request, the span filters and the statements, and the strategies of
  # the search and of the analytics on a fake executor.
  add_executable(chdash_trace_test ../tests/native/trace_test.cpp
    trace_analytics.cpp trace_attributes.cpp trace_detail.cpp trace_facets.cpp trace_filters.cpp trace_json.cpp trace_request.cpp trace_search.cpp trace_service.cpp trace_services.cpp trace_spans.cpp trace_sql.cpp
    ch_query.cpp ch_client_pool.cpp ch_uri.cpp ch_error.cpp api_error.cpp error_envelope.cpp request_context.cpp log.cpp jwt.cpp secure_random.cpp)
  target_include_directories(chdash_trace_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_trace_test SYSTEM PRIVATE ${clickhouse_cpp_SOURCE_DIR} ${httplib_SOURCE_DIR} ${rapidjson_SOURCE_DIR}/include)
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_trace_test PRIVATE clickhouse-cpp-lib Threads::Threads)
  chdash_configure_target(chdash_trace_test)
endif()

if (CHDASH_BUILD_FUZZERS)
  # The libFuzzer targets of tests/fuzz: the parsers that read what a client, a config file or a pasted text
  # sends, and the WebAssembly kernels of the page built natively. Build them with clang and
  # CHDASH_SANITIZE=address,undefined; tests/tools/fuzz.sh builds them in tests/Dockerfile.sanitize and runs each.
  if (NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
    message(FATAL_ERROR "CHDASH_BUILD_FUZZERS needs clang (libFuzzer)")
  endif()
  enable_language(C)
  set(_FUZZ_DIR "${CMAKE_CURRENT_LIST_DIR}/../tests/fuzz")
  set(CHDASH_FUZZERS "")
  function(chdash_add_fuzzer name)
    add_executable(${name} ${ARGN})
    target_include_directories(${name} PRIVATE ${CMAKE_CURRENT_LIST_DIR})
    target_include_directories(${name} SYSTEM PRIVATE ${rapidjson_SOURCE_DIR}/include)
    set_target_properties(${name} PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED ON)
    chdash_configure_target(${name})
    target_compile_options(${name} PRIVATE -fsanitize=fuzzer)
    target_link_options(${name} PRIVATE -fsanitize=fuzzer)
    set(CHDASH_FUZZERS ${CHDASH_FUZZERS} ${name} PARENT_SCOPE)
  endfunction()
  chdash_add_fuzzer(chdash_fuzz_json_parse ${_FUZZ_DIR}/fuzz_json_parse.cpp)
  chdash_add_fuzzer(chdash_fuzz_format ${_FUZZ_DIR}/fuzz_format.cpp format_postprocess.cpp)
  chdash_add_fuzzer(chdash_fuzz_mcp_sql ${_FUZZ_DIR}/fuzz_mcp_sql.cpp mcp_sql.cpp)
  chdash_add_fuzzer(chdash_fuzz_user_sql_policy ${_FUZZ_DIR}/fuzz_user_sql_policy.cpp user_sql_policy.cpp)
  chdash_add_fuzzer(chdash_fuzz_hcl ${_FUZZ_DIR}/fuzz_hcl.cpp hcl.cpp)
  # A kernel target includes src/wasm/<name>.c after tests/fuzz/wasm_native_rt.h (malloc blocks, libm).
  foreach(_kernel IN ITEMS highlight sqlscan color rowsort chartprep treemap layered labels router)
    chdash_add_fuzzer(chdash_fuzz_wasm_${_kernel} ${_FUZZ_DIR}/fuzz_wasm_${_kernel}.c)
    target_link_libraries(chdash_fuzz_wasm_${_kernel} PRIVATE m)
  endforeach()
  add_custom_target(chdash_fuzzers DEPENDS ${CHDASH_FUZZERS})
endif()

if (CHDASH_BUILD_SYSTEM_TESTS)
  # The System page SQL builders and the disk forecast (no ClickHouse needed).
  add_executable(chdash_system_monitor_test ../tests/native/system_monitor_test.cpp system_monitor.cpp allowed_objects.cpp acl_service.cpp
    ch_query.cpp ch_client_pool.cpp ch_uri.cpp jwt.cpp)
  target_include_directories(chdash_system_monitor_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_system_monitor_test SYSTEM PRIVATE ${clickhouse_cpp_SOURCE_DIR} ${rapidjson_SOURCE_DIR}/include)
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_system_monitor_test PRIVATE clickhouse-cpp-lib Threads::Threads)
  chdash_configure_target(chdash_system_monitor_test)
endif()

if (CHDASH_BUILD_APP)
  add_executable(chdash
    main.cpp
    config.cpp
    config_schema.cpp
    server.cpp
    api_error.cpp
    error_envelope.cpp
    ch_error.cpp
    request_context.cpp
    http_json.cpp
    api_hosts.cpp
    api_meta.cpp
    api_format.cpp
    format_clickhouse.cpp
    format_service.cpp
    format_cache.cpp
    format_postprocess.cpp
    api_query.cpp
    user_sql_policy.cpp
    api_query_stream.cpp
    api_analysis.cpp
    query_session.cpp
    hcl.cpp
    jwt.cpp
    query_registry.cpp
    query_analysis.cpp
    query_execution.cpp
    api_query_execution.cpp
    deep_analysis.cpp
    deep_analysis_jobs.cpp
    api_export.cpp
    export_job.cpp
    export_serializer.cpp
    zip_stream.cpp
    acl_service.cpp
    allowed_objects.cpp
    explorer_catalog.cpp
    explorer_detail.cpp
    explorer_functions.cpp
    explorer_graph.cpp
    explorer_graph_build.cpp
    explorer_graph_scope.cpp
    explorer_index.cpp
    explorer_json.cpp
    explorer_lineage.cpp
    explorer_preview.cpp
    explorer_replicas.cpp
    explorer_rules.cpp
    explorer_service.cpp
    explorer_sql.cpp
    explorer_storage.cpp
    explorer_table.cpp
    explorer_ttl.cpp
    sql_structure.cpp
    system_activity.cpp
    system_monitor.cpp
    api_explorer.cpp
    api_system_activity.cpp
    api_system.cpp
    api_traces.cpp
    trace_analytics.cpp
    trace_attributes.cpp
    trace_detail.cpp
    trace_facets.cpp
    trace_filters.cpp
    trace_json.cpp
    trace_request.cpp
    trace_search.cpp
    trace_service.cpp
    trace_services.cpp
    trace_spans.cpp
    trace_sql.cpp
    api_otel_signals.cpp
    api_trace_logs.cpp
    api_logs.cpp
    logs_text.cpp
    logs_drain.cpp
    logs_patterns.cpp
    logs_request.cpp
    logs_filters.cpp
    logs_sql.cpp
    logs_service.cpp
    logs_json.cpp
    api_metrics.cpp
    metrics_aggregate.cpp
    metrics_json.cpp
    metrics_request.cpp
    metrics_service.cpp
    metrics_sql.cpp
    ${CHDASH_QUERY_LIBRARY_SOURCES}
    api_query_library.cpp
    mcp_scope.cpp
    mcp_identity.cpp
    mcp_grants.cpp
    mcp_api_tools.cpp
    mcp_keys.cpp
    mcp_sql.cpp
    mcp_protocol.cpp
    mcp_tools.cpp
    api_mcp.cpp
    ch_uri.cpp
    ch_query.cpp
    ch_client_pool.cpp
    health_runner.cpp
    secure_random.cpp
    log.cpp
    http_guard.cpp
    metrics.cpp
    server_http.cpp
  )
endif()

if (CHDASH_BUILD_APP AND CHDASH_EMBED_STATIC)
  include(${CMAKE_CURRENT_LIST_DIR}/EmbedStatic.cmake)

  set(_STATIC_DIR "${CMAKE_CURRENT_LIST_DIR}/static")
  set(_STATIC_STAGE "${CMAKE_BINARY_DIR}/static")
  set(_EMBED_CPP  "${CMAKE_BINARY_DIR}/embedded_static.cpp")
  set(_EMBED_HPP  "${CMAKE_BINARY_DIR}/embedded_static.hpp")

  # The page stylesheets (style.<page>.css) are build outputs: stage src/static
  # without the stylesheet sources (static/css/) and the sheets a local
  # `python3 tools/build_page_css.py` may have left there, then generate the
  # sheets into the stage and embed it.
  find_package(Python3 COMPONENTS Interpreter REQUIRED)
  set(_CSS_TOOL "${CMAKE_CURRENT_LIST_DIR}/../tools/build_page_css.py")
  file(REMOVE_RECURSE "${_STATIC_STAGE}")
  file(COPY "${_STATIC_DIR}/" DESTINATION "${_STATIC_STAGE}"
       PATTERN "css" EXCLUDE
       REGEX "/style\\.[a-z.]+\\.css$" EXCLUDE)
  execute_process(
    COMMAND "${Python3_EXECUTABLE}" "${_CSS_TOOL}" --out "${_STATIC_STAGE}"
    RESULT_VARIABLE _CSS_RESULT)
  if(NOT _CSS_RESULT EQUAL 0)
    message(FATAL_ERROR "tools/build_page_css.py failed (${_CSS_RESULT})")
  endif()
  # Then version the scripts and stylesheets (?v=<hash> in the shells) and write the .gz copies.
  set(_STAGE_TOOL "${CMAKE_CURRENT_LIST_DIR}/../tools/stage_static.py")
  execute_process(
    COMMAND "${Python3_EXECUTABLE}" "${_STAGE_TOOL}" "${_STATIC_STAGE}"
    RESULT_VARIABLE _STAGE_RESULT)
  if(NOT _STAGE_RESULT EQUAL 0)
    message(FATAL_ERROR "tools/stage_static.py failed (${_STAGE_RESULT})")
  endif()
  # Stage again when anything under src/static (the stylesheet sources, the
  # shells, modules.json, the scripts the sheets are filtered by) or the
  # generator changes.
  file(GLOB_RECURSE _STATIC_SOURCES CONFIGURE_DEPENDS "${_STATIC_DIR}/*")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    ${_STATIC_SOURCES}
    "${_CSS_TOOL}"
    "${_STAGE_TOOL}"
    "${CMAKE_CURRENT_LIST_DIR}/../tools/css_tree.py"
    "${CMAKE_CURRENT_LIST_DIR}/../tools/icons.py"
    "${CMAKE_CURRENT_LIST_DIR}/../tools/module_graph.py"
    "${CMAKE_CURRENT_LIST_DIR}/../tools/page_shells.py"
    "${CMAKE_CURRENT_LIST_DIR}/shell/header.html")

  chdash_embed_directory("${_STATIC_STAGE}" "${_EMBED_CPP}" "${_EMBED_HPP}" "chdash_embedded")

  target_sources(chdash PRIVATE "${_EMBED_CPP}")
  target_include_directories(chdash PRIVATE "${CMAKE_BINARY_DIR}")
  target_compile_definitions(chdash PRIVATE CHDASH_EMBED_STATIC=1)
endif()

if (CHDASH_BUILD_APP)
  chdash_configure_target(chdash)

  target_include_directories(chdash SYSTEM PRIVATE
    ${clickhouse_cpp_SOURCE_DIR}
    ${httplib_SOURCE_DIR}
    ${rapidjson_SOURCE_DIR}/include
  )

  target_compile_definitions(chdash PRIVATE
    CHDASH_SEMVER="${CHDASH_SEMVER_VALUE}"
    CHDASH_GIT_SHA="${CHDASH_GIT_SHA_VALUE}"
    CHDASH_BUILD_TIME="${CHDASH_BUILD_TIME_VALUE}"
  )

  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash PRIVATE
    clickhouse-cpp-lib
    Threads::Threads
  )
  # The stack of every thread (musl, the release binaries and the test image: 128 KiB by default, which
  # a deep JSON body or SQL text once overflowed). musl takes the default thread stack from this size;
  # glibc already gives 8 MiB. The parsers bound their depth too (json_parse.hpp, format_postprocess.cpp).
  if (CMAKE_SYSTEM_NAME STREQUAL "Linux")
    target_link_options(chdash PRIVATE "LINKER:-z,stack-size=8388608")
  endif()
endif()
