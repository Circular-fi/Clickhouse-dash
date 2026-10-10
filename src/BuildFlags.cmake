# Compiler warnings and sanitizers for the ChDash sources.
#
# Options (set them with -D on the cmake command line):
#   CHDASH_WERROR=ON               Every warning of the ChDash sources is an error. CI and the test
#                                  images turn it on. The release build keeps it OFF, so that a new
#                                  compiler cannot stop a release.
#   CHDASH_SANITIZE=address,undefined
#                                  Build with these sanitizers. Allowed words: address, undefined,
#                                  thread. AddressSanitizer covers the dependencies too; UndefinedBehavior-
#                                  Sanitizer covers our targets only. A UBSan finding stops the
#                                  process (-fno-sanitize-recover=undefined).
#   CHDASH_SANITIZE=thread         ThreadSanitizer, on the whole build (the dependencies too). It
#                                  cannot be combined with address.
#   CHDASH_HARDEN=ON               The hardening flags of the release binary (default ON; OFF with
#                                  sanitizers): stack protector, stack clash protection, zeroed
#                                  automatic variables, _FORTIFY_SOURCE=3 with optimisation, and the
#                                  hardened mode of libc++. The flags the compiler does not know are
#                                  skipped. A position independent executable is a link choice of the
#                                  build (release.yaml: -static-pie).
#
# The warnings apply to our targets only (chdash and the native test targets). The dependencies
# (clickhouse-cpp, cpp-httplib, rapidjson) never get them.
#
# To silence one false positive: fix the code when you can. Otherwise put a local
# `#pragma GCC diagnostic ignored "-W<name>"` (inside push/pop) around that line, with a comment
# that says why the warning is wrong. Never turn a warning off for a whole target.

set(CHDASH_WERROR OFF CACHE BOOL "Treat the warnings of the ChDash sources as errors")
set(CHDASH_SANITIZE "" CACHE STRING "Sanitizers for the whole build: address, undefined (comma separated), or thread")

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
    if (NOT _name MATCHES "^(address|undefined|thread)$")
      message(FATAL_ERROR "CHDASH_SANITIZE: unknown sanitizer '${_name}' (allowed: address, undefined, thread)")
    endif()
  endforeach()
  if ("thread" IN_LIST _chdash_sanitizers AND "address" IN_LIST _chdash_sanitizers)
    message(FATAL_ERROR "CHDASH_SANITIZE: thread cannot be combined with address")
  endif()
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
  if ("thread" IN_LIST _chdash_sanitizers)
    # ThreadSanitizer is global too: an access of clickhouse-cpp or cpp-httplib that is not instrumented
    # hides one side of a race.
    add_compile_options(-fsanitize=thread -fno-omit-frame-pointer -g1)
    add_link_options(-fsanitize=thread)
  endif()
  # SIGTERM and SIGINT end the server cleanly (src/main.cpp), so LeakSanitizer reports at exit.
  add_compile_definitions(CHDASH_SHUTDOWN_ON_SIGNAL=1)
  message(STATUS "ChDash sanitizers: ${CHDASH_SANITIZE}")
endif()

# Hardening of the whole build (the dependencies too: a stack protector on our functions only would
# leave the parsers of cpp-httplib and clickhouse-cpp without one). Each flag is tested first: Zig's
# clang, Apple clang, GCC and an old compiler accept different sets.
set(_chdash_harden_default ON)
if (CHDASH_SANITIZE)
  set(_chdash_harden_default OFF)
endif()
set(CHDASH_HARDEN ${_chdash_harden_default} CACHE BOOL "Build with the hardening flags (stack protector, fortify, ...)")
if (CHDASH_HARDEN AND NOT MSVC)
  include(CheckCXXSourceCompiles)
  foreach(_flag -fstack-protector-strong -fstack-clash-protection -ftrivial-auto-var-init=zero)
    string(MAKE_C_IDENTIFIER "CHDASH_HAS${_flag}" _var)
    check_cxx_compiler_flag(${_flag} ${_var})
    if (${_var})
      add_compile_options(${_flag})
    endif()
  endforeach()
  # _FORTIFY_SOURCE needs optimisation (glibc warns without it), and the compiler may already define it.
  # musl has no fortified functions: there the macro does nothing.
  set(_chdash_optimized "$<CONFIG:Release,RelWithDebInfo,MinSizeRel>")
  add_compile_options("$<${_chdash_optimized}:-U_FORTIFY_SOURCE>" "$<${_chdash_optimized}:-D_FORTIFY_SOURCE=3>")
  # The checks of the standard library that cost little (the bounds of operator[], front() of an empty
  # container...): the hardened mode of libc++ 18 and later (the release build: Zig), the assertions of
  # libstdc++ (the test images).
  check_cxx_source_compiles("
    #include <version>
    #if !defined(_LIBCPP_VERSION) || _LIBCPP_VERSION < 180000
    #error not libc++ 18
    #endif
    int main() { return 0; }" CHDASH_HAS_LIBCXX_HARDENING)
  check_cxx_source_compiles("
    #include <version>
    #ifndef __GLIBCXX__
    #error not libstdc++
    #endif
    int main() { return 0; }" CHDASH_HAS_LIBSTDCXX)
  if (CHDASH_HAS_LIBCXX_HARDENING)
    add_compile_options(-U_LIBCPP_HARDENING_MODE -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST)
  elseif (CHDASH_HAS_LIBSTDCXX)
    add_compile_definitions(_GLIBCXX_ASSERTIONS)
  endif()
  message(STATUS "ChDash hardening: ON")
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
