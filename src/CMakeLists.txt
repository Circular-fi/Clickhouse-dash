cmake_minimum_required(VERSION 3.20)
project(chdash LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(CHDASH_EMBED_STATIC "Embed src/static into the chdash binary" ON)
option(CHDASH_BUILD_APP "Build chdash executable" ON)
option(CHDASH_BUILD_CODEC_TESTS "Build the processor JSON codec test driver" OFF)
option(CHDASH_BUILD_QUERY_LIBRARY_TESTS "Build the query library store unit tests" OFF)
option(CHDASH_BUILD_SYSTEM_TESTS "Build the System page SQL builder unit tests" OFF)

set(CHDASH_SEMVER_VALUE "dev" CACHE STRING "Semantic version embedded in the binary")
set(CHDASH_GIT_SHA_VALUE "unknown" CACHE STRING "Git SHA embedded in the binary")
set(CHDASH_BUILD_TIME_VALUE "unknown" CACHE STRING "Build time embedded in the binary")

include(FetchContent)

set(RAPIDJSON_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(RAPIDJSON_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(RAPIDJSON_BUILD_DOC OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
  clickhouse_cpp
  GIT_REPOSITORY https://github.com/ClickHouse/clickhouse-cpp.git
  GIT_TAG        v2.6.2
)
FetchContent_MakeAvailable(clickhouse_cpp)

FetchContent_Declare(
  httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG        9d6a7ee2c1aaeb1fd9ae15d14f06f487149d147f
)
FetchContent_MakeAvailable(httplib)

FetchContent_Declare(
  rapidjson
  GIT_REPOSITORY https://github.com/Tencent/rapidjson.git
  GIT_TAG        24b5e7a8b27f42fa16b96fc70aade9106cf7102f
)
FetchContent_MakeAvailable(rapidjson)

if (CHDASH_BUILD_CODEC_TESTS)
  add_executable(chdash_processor_codec_test ../tests/native/processor_json_driver.cpp)
  target_include_directories(chdash_processor_codec_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_processor_codec_test SYSTEM PRIVATE ${rapidjson_SOURCE_DIR}/include)
endif()

if (CHDASH_BUILD_QUERY_LIBRARY_TESTS)
  add_executable(chdash_query_library_test ../tests/native/query_library_test.cpp query_library.cpp)
  target_include_directories(chdash_query_library_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_query_library_test SYSTEM PRIVATE ${rapidjson_SOURCE_DIR}/include)
  if (NOT MSVC)
    target_compile_options(chdash_query_library_test PRIVATE -Wall -Wextra)
  endif()
endif()

if (CHDASH_BUILD_SYSTEM_TESTS)
  # The System page SQL builders and the disk forecast (no ClickHouse needed).
  add_executable(chdash_system_monitor_test ../tests/native/system_monitor_test.cpp system_monitor.cpp allowed_objects.cpp)
  target_include_directories(chdash_system_monitor_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
  target_include_directories(chdash_system_monitor_test SYSTEM PRIVATE ${clickhouse_cpp_SOURCE_DIR})
  set(THREADS_PREFER_PTHREAD_FLAG ON)
  find_package(Threads REQUIRED)
  target_link_libraries(chdash_system_monitor_test PRIVATE clickhouse-cpp-lib Threads::Threads)
  if (NOT MSVC)
    target_compile_options(chdash_system_monitor_test PRIVATE -Wall -Wextra)
  endif()
endif()

if (CHDASH_BUILD_APP)
  add_executable(chdash
    main.cpp
    config.cpp
    server.cpp
    api_error.cpp
    http_json.cpp
    api_hosts.cpp
    api_meta.cpp
    api_format.cpp
    format_clickhouse.cpp
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
    api_export.cpp
    export_job.cpp
    export_serializer.cpp
    zip_stream.cpp
    allowed_objects.cpp
    explorer_catalog.cpp
    explorer_graph.cpp
    system_activity.cpp
    system_monitor.cpp
    api_explorer.cpp
    api_system_activity.cpp
    api_system.cpp
    api_traces.cpp
    api_otel_signals.cpp
    api_trace_logs.cpp
    api_logs.cpp
    api_metrics.cpp
    query_library.cpp
    api_query_library.cpp
    ch_uri.cpp
    ch_client_pool.cpp
    health_runner.cpp
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
    "${CMAKE_CURRENT_LIST_DIR}/../tools/page_shells.py"
    "${CMAKE_CURRENT_LIST_DIR}/shell/header.html")

  chdash_embed_directory("${_STATIC_STAGE}" "${_EMBED_CPP}" "${_EMBED_HPP}" "chdash_embedded")

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
endif()
