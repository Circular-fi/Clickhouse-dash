# EmbedStatic.cmake
# Generates C++ sources that embed every file under a directory into the binary.
# Usage:
#   chdash_embed_directory(<dir> <out_cpp> <out_hpp> <namespace>)

function(chdash_embed_directory DIR OUTPUT_CPP OUTPUT_HPP NS)
  if(NOT IS_DIRECTORY "${DIR}")
    message(FATAL_ERROR "Embed directory not found: ${DIR}")
  endif()

  file(GLOB_RECURSE _files CONFIGURE_DEPENDS LIST_DIRECTORIES false RELATIVE "${DIR}" "${DIR}/*")

  if(NOT _files)
    message(FATAL_ERROR "No files found to embed in: ${DIR}")
  endif()

  set(_cpp "${OUTPUT_CPP}")
  set(_hpp "${OUTPUT_HPP}")

  file(WRITE "${_hpp}"
"#pragma once
#include <cstddef>
#include <string_view>

namespace ${NS} {
struct Asset { const char* path; const unsigned char* data; size_t size; const char* content_hash; };
// Returns nullptr if not found.
const Asset* find(std::string_view path);
}
")

  file(WRITE "${_cpp}"
"#include \"${_hpp}\"
#include <cstring>

namespace ${NS} {
")

  foreach(f IN LISTS _files)
    set(_abs "${DIR}/${f}")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${_abs}")

    # Make a valid C symbol name from relative path
    string(REPLACE "/" "_" sym "${f}")
    string(REPLACE "\\" "_" sym "${sym}")
    string(REPLACE "." "_" sym "${sym}")
    string(REPLACE "-" "_" sym "${sym}")
    string(REPLACE " " "_" sym "${sym}")
    string(REPLACE ":" "_" sym "${sym}")

    file(READ "${_abs}" _hex HEX)
    file(SHA256 "${_abs}" _sha256)
    string(LENGTH "${_hex}" _hex_len)

    if((_hex_len LESS 2) OR (NOT (_hex_len GREATER 0)))
      # Empty file: emit empty array
      file(APPEND "${_cpp}" "static const unsigned char data_${sym}[] = {};\n")
      file(APPEND "${_cpp}" "static const Asset asset_${sym} = {\"${f}\", data_${sym}, 0, \"${_sha256}\"};\n\n")
      continue()
    endif()

    math(EXPR _nbytes "${_hex_len} / 2")
    if(_nbytes LESS 1)
      file(APPEND "${_cpp}" "static const unsigned char data_${sym}[] = {};\n")
      file(APPEND "${_cpp}" "static const Asset asset_${sym} = {\"${f}\", data_${sym}, 0, \"${_sha256}\"};\n\n")
      continue()
    endif()

    # One regex pass per file (a CMake loop per byte takes minutes on a few MB of assets): "0x41,0x42,..."
    # with a line break every 16 bytes.
    string(REPEAT "0x[0-9a-f][0-9a-f]," 16 _row_pattern)
    string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," _bytes "${_hex}")
    string(REGEX REPLACE "(${_row_pattern})" "\\1\n  " _bytes "${_bytes}")
    file(APPEND "${_cpp}" "static const unsigned char data_${sym}[] = {\n  ${_bytes}")
    file(APPEND "${_cpp}" "\n};\n")
    file(APPEND "${_cpp}" "static const Asset asset_${sym} = {\"${f}\", data_${sym}, sizeof(data_${sym}), \"${_sha256}\"};\n\n")
  endforeach()

  file(APPEND "${_cpp}" "static const Asset* assets[] = {\n")
  foreach(f IN LISTS _files)
    string(REPLACE "/" "_" sym "${f}")
    string(REPLACE "\\" "_" sym "${sym}")
    string(REPLACE "." "_" sym "${sym}")
    string(REPLACE "-" "_" sym "${sym}")
    string(REPLACE " " "_" sym "${sym}")
    string(REPLACE ":" "_" sym "${sym}")
    file(APPEND "${_cpp}" "  &asset_${sym},\n")
  endforeach()
  file(APPEND "${_cpp}" "};\n\n")

  file(APPEND "${_cpp}"
"const Asset* find(std::string_view path) {
  for (auto* a : assets) {
    const size_t n = std::strlen(a->path);
    if (path.size() == n && std::memcmp(path.data(), a->path, n) == 0) return a;
  }
  return nullptr;
}
} // namespace
")
endfunction()
