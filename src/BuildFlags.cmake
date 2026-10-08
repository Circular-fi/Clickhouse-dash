# Compiler warnings and sanitizers for the ChDash sources.
#
# Options (set them with -D on the cmake command line):
#   CHDASH_WERROR=ON               Every warning of the ChDash sources is an error. CI and the test
#                                  images turn it on. The release build keeps it OFF, so that a new
#                                  compiler cannot stop a release.
#   CHDASH_SANITIZE=address,undefined
#                                  Build with these sanitizers. Allowed words: address, undefined.
#                                  AddressSanitizer covers the dependencies too; UndefinedBehavior-
#                                  Sanitizer covers our targets only. A UBSan finding stops the
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

# Sanitizers. AddressSanitizer is global: the dependencies are instrumented too, because a mixed build
# misses container overflows and some leaks. UndefinedBehaviorSanitizer applies to our targets only: the
# vendored dependencies hold findings that are not ours to fix (lz4 adds 0 to a null pointer for an empty
# block, for example). A finding of ours stops the process (-fno-sanitize-recover=undefined).
set(CHDASH_SANITIZER_COMPILE_FLAGS "")
set(CHDASH_SANITIZER_LINK_FLAGS "")
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
  list(APPEND CHDASH_SANITIZER_COMPILE_FLAGS "-fsanitize=${CHDASH_SANITIZE}" -fno-omit-frame-pointer)
  if ("undefined" IN_LIST _chdash_sanitizers)
    list(APPEND CHDASH_SANITIZER_COMPILE_FLAGS -fno-sanitize-recover=undefined)
  endif()
  set(CHDASH_SANITIZER_LINK_FLAGS "-fsanitize=${CHDASH_SANITIZE}")
  if ("address" IN_LIST _chdash_sanitizers)
    # Everything else (the dependencies): AddressSanitizer only.
    add_compile_options(-fsanitize=address -fno-omit-frame-pointer -g1)
    add_link_options(-fsanitize=address)
  endif()
  # SIGTERM and SIGINT end the server cleanly (src/main.cpp), so LeakSanitizer reports at exit.
  add_compile_definitions(CHDASH_SHUTDOWN_ON_SIGNAL=1)
  message(STATUS "ChDash sanitizers: ${CHDASH_SANITIZE}")
endif()

# chdash_configure_target(<target>...): the warning set and the sanitizers, on our targets only.
function(chdash_configure_target)
  foreach(_target IN LISTS ARGN)
    if (MSVC)
      target_compile_options(${_target} PRIVATE /W4)
    else()
      target_compile_options(${_target} PRIVATE ${CHDASH_WARNING_FLAGS} ${CHDASH_SANITIZER_COMPILE_FLAGS})
      if (CHDASH_SANITIZER_LINK_FLAGS)
        target_link_options(${_target} PRIVATE ${CHDASH_SANITIZER_LINK_FLAGS})
      endif()
    endif()
  endforeach()
endfunction()
