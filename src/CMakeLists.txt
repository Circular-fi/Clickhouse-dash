cmake_minimum_required(VERSION 3.20)
project(chdash LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(CHDASH_EMBED_STATIC "Embed src/static into the chdash binary" ON)
option(CHDASH_BUILD_APP "Build chdash executable" ON)

include(FetchContent)

set(RAPIDJSON_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(RAPIDJSON_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(RAPIDJSON_BUILD_DOC OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
  clickhouse_cpp
  GIT_REPOSITORY https://github.com/ClickHouse/clickhouse-cpp.git
  GIT_TAG        v2.6.0
)
FetchContent_MakeAvailable(clickhouse_cpp)

# Local compatibility patch for clickhouse-cpp v2.6.0:
# - skip custom-serialization descriptors instead of failing hard
# - map JSON / AggregateFunction result columns to ColumnString on reads
function(chdash_patch_clickhouse_cpp source_dir)
  set(_client_cpp "${source_dir}/clickhouse/client.cpp")
  set(_factory_cpp "${source_dir}/clickhouse/columns/factory.cpp")

  if (EXISTS "${_client_cpp}")
    file(READ "${_client_cpp}" _client_src)
    string(FIND "${_client_src}" "unsupported custom serialization" _has_old_custom)
    if (NOT _has_old_custom EQUAL -1)
      string(REPLACE
"        if (server_info_.revision >= DBMS_MIN_REVISION_WITH_CUSTOM_SERIALIZATION) {\n            uint8_t custom_format_len;\n            if (!WireFormat::ReadFixed(input, &custom_format_len)) {\n                return false;\n            }\n            if (custom_format_len > 0) {\n                throw UnimplementedError(std::string(\"unsupported custom serialization\"));\n            }\n        } "
"        if (server_info_.revision >= DBMS_MIN_REVISION_WITH_CUSTOM_SERIALIZATION) {\n            uint8_t custom_format_len;\n            if (!WireFormat::ReadFixed(input, &custom_format_len)) {\n                return false;\n            }\n            if (custom_format_len > 0) {\n                std::string custom_format;\n                custom_format.resize(custom_format_len);\n                if (!WireFormat::ReadBytes(input, custom_format.data(), custom_format.size())) {\n                    return false;\n                }\n            }\n        } "
        _client_src "${_client_src}")
      file(WRITE "${_client_cpp}" "${_client_src}")
    endif()
  endif()

  if (EXISTS "${_factory_cpp}")
    file(READ "${_factory_cpp}" _factory_src)
    string(FIND "${_factory_src}" "type_name == \"JSON\"" _has_json_patch)
    if (_has_json_patch EQUAL -1)
      string(REPLACE
"ColumnRef CreateColumnByType(const std::string& type_name, CreateColumnByTypeSettings settings) {\n    auto ast = ParseTypeName(type_name);"
"ColumnRef CreateColumnByType(const std::string& type_name, CreateColumnByTypeSettings settings) {\n    if (type_name == \"JSON\"\n        || type_name == \"Object('json')\"\n        || type_name == \"Object('JSON')\"\n        || type_name.rfind(\"JSON(\", 0) == 0\n        || type_name.rfind(\"AggregateFunction(\", 0) == 0) {\n        return std::make_shared<ColumnString>();\n    }\n    auto ast = ParseTypeName(type_name);"
        _factory_src "${_factory_src}")
      file(WRITE "${_factory_cpp}" "${_factory_src}")
    endif()
  endif()
endfunction()

chdash_patch_clickhouse_cpp(${clickhouse_cpp_SOURCE_DIR})

FetchContent_Declare(
  httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG        v0.15.3
)
FetchContent_MakeAvailable(httplib)

FetchContent_Declare(
  rapidjson
  GIT_REPOSITORY https://github.com/Tencent/rapidjson.git
  GIT_TAG        v1.1.0
)
FetchContent_MakeAvailable(rapidjson)

if (CHDASH_BUILD_APP)
  add_executable(chdash
    main.cpp
    server.cpp
    api_error.cpp
    http_json.cpp
    api_hosts.cpp
    api_meta.cpp
    api_format.cpp
    format_clickhouse.cpp
    format_postprocess.cpp
    api_query.cpp
    api_query_stream.cpp
    query_sql_store.cpp
    query_session.cpp
    hcl.cpp
    jwt.cpp
    ch_uri.cpp
    health_runner.cpp
  )
endif()

if (CHDASH_BUILD_APP AND CHDASH_EMBED_STATIC)
  include(${CMAKE_CURRENT_LIST_DIR}/EmbedStatic.cmake)

  set(_STATIC_DIR "${CMAKE_CURRENT_LIST_DIR}/static")
  set(_EMBED_CPP  "${CMAKE_BINARY_DIR}/embedded_static.cpp")
  set(_EMBED_HPP  "${CMAKE_BINARY_DIR}/embedded_static.hpp")

  chdash_embed_directory("${_STATIC_DIR}" "${_EMBED_CPP}" "${_EMBED_HPP}" "chdash_embedded")

  target_sources(chdash PRIVATE "${_EMBED_CPP}")
  target_include_directories(chdash PRIVATE "${CMAKE_BINARY_DIR}")
  target_compile_definitions(chdash PRIVATE CHDASH_EMBED_STATIC=1)
endif()

if (CHDASH_BUILD_APP)
  if (MSVC)
    target_compile_options(chdash PRIVATE /W4)
  else()
    target_compile_options(chdash PRIVATE
      -Wall -Wextra
      -Wno-error
      -Wno-error=implicit-fallthrough
      -Wno-implicit-fallthrough
    )
  endif()

  target_include_directories(chdash PRIVATE
    ${clickhouse_cpp_SOURCE_DIR}
    ${httplib_SOURCE_DIR}
    ${rapidjson_SOURCE_DIR}/include
  )

  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash PRIVATE
    clickhouse-cpp-lib
    Threads::Threads
  )
endif()
