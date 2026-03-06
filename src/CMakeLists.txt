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
    api_hosts.cpp
    api_meta.cpp
    api_format.cpp
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
