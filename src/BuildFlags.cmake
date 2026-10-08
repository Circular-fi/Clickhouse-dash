# Compiler warnings and sanitizers for the ChDash sources.
#
# Options (set them with -D on the cmake command line):
#   CHDASH_WERROR=ON               Every warning of the ChDash sources is an error. CI and the test
#                                  images turn it on. The release build keeps it OFF, so that a new
#                                  compiler cannot stop a release.
#   CHDASH_SANITIZE=address,undefined
#                                  Build everything (the dependencies too) with these sanitizers.
#                                  Allowed words: address, undefined. A UBSan finding stops the
#                                  process (-fno-sanitize-recover=undefined).
#
# The warnings apply to our targets only (chdash and the native test targets). The dependencies
# (clickhouse-cpp, cpp-httplib, rapidjson) never get them.
#
# To silence one false positive: fix the code when you can. Otherwise put a local
# `#pragma GCC diagnostic ignored "-W<name>"` (inside push/pop) around that line, with a comment
# that says why the warning is wrong. Never turn a warning off for a whole target.

set(CHDASH_WERROR OFF CACHE BOOL "Treat the warnings of the ChDash sources as errors")
set(CHDASH_SANITIZE "" CACHE STRING "Sanitizers for the whole build: address, undefined (comma separated)")

include(CheckCXXCompilerFlag)

set(CHDASH_WARNING_FLAGS "")
if (NOT MSVC)
  list(APPEND CHDASH_WARNING_FLAGS -Wall -Wextra)
  # GCC 13 and later: a reference that binds to a temporary or to a member of one.
  check_cxx_compiler_flag(-Wdangling-reference CHDASH_HAS_WDANGLING_REFERENCE)
  if (CHDASH_HAS_WDANGLING_REFERENCE)
    list(APPEND CHDASH_WARNING_FLAGS -Wdangling-reference)
  endif()
  if (CHDASH_WERROR)
    list(APPEND CHDASH_WARNING_FLAGS -Werror)
  endif()
endif()

# chdash_enable_warnings(<target>...): the warning set above, on our targets only.
function(chdash_enable_warnings)
  foreach(_target IN LISTS ARGN)
    if (MSVC)
      target_compile_options(${_target} PRIVATE /W4)
    else()
      target_compile_options(${_target} PRIVATE ${CHDASH_WARNING_FLAGS})
    endif()
  endforeach()
endfunction()

# Sanitizers: global, so the dependencies are instrumented too (a mixed build misses
# container-overflow and some leaks).
if (CHDASH_SANITIZE)
  if (MSVC)
    message(FATAL_ERROR "CHDASH_SANITIZE is not supported with MSVC")
  endif()
  string(REPLACE "," ";" _chdash_sanitizers "${CHDASH_SANITIZE}")
  foreach(_name IN LISTS _chdash_sanitizers)
    if (NOT _name MATCHES "^(address|undefined)$")
      message(FATAL_ERROR "CHDASH_SANITIZE: unknown sanitizer '${_name}' (allowed: address, undefined)")
    endif()
  endforeach()
  set(_chdash_san_flags "-fsanitize=${CHDASH_SANITIZE}" -fno-omit-frame-pointer)
  if ("undefined" IN_LIST _chdash_sanitizers)
    list(APPEND _chdash_san_flags -fno-sanitize-recover=undefined)
  endif()
  add_compile_options(${_chdash_san_flags} -g1)
  add_link_options(${_chdash_san_flags})
  message(STATUS "ChDash sanitizers: ${CHDASH_SANITIZE}")
endif()
