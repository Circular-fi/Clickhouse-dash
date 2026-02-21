cmake_minimum_required(VERSION 3.20)
project(chdash LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)

# ---- Disable all RapidJSON extras (examples/tests/docs) ----
set(RAPIDJSON_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(RAPIDJSON_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(RAPIDJSON_BUILD_DOC OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)

# clickhouse-cpp
FetchContent_Declare(
  clickhouse_cpp
  GIT_REPOSITORY https://github.com/ClickHouse/clickhouse-cpp.git
  GIT_TAG        v2.6.0
)
FetchContent_MakeAvailable(clickhouse_cpp)

# cpp-httplib (header-only)
FetchContent_Declare(
  httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG        v0.15.3
)
FetchContent_MakeAvailable(httplib)

# rapidjson (header-only)
FetchContent_Declare(
  rapidjson
  GIT_REPOSITORY https://github.com/Tencent/rapidjson.git
  GIT_TAG        v1.1.0
)
FetchContent_MakeAvailable(rapidjson)

add_executable(chdash
  main.cpp
  server.cpp
  query_session.cpp
)

# Important: apply warning flags ONLY to our target.
# Putting -Wall/-Wextra at directory scope makes CMake translate them to /Wextra on MSVC
# and they propagate into dependencies (absl/zstd/...), breaking Windows builds.
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

# pthreads (souvent requis)
set(THREADS_PREFER_PTHREAD_FLAG ON)
find_package(Threads REQUIRED)

target_link_libraries(chdash PRIVATE
  clickhouse-cpp-lib
  Threads::Threads
)
