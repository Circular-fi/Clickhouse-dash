# EmbedStatic.cmake
# Generates C++ sources that embed every file under a directory into the binary.
# Usage:
#   chdash_embed_directory(<dir> <out_cpp> <out_hpp> <namespace>)

function(chdash_embed_directory DIR OUTPUT_CPP OUTPUT_HPP NS)
  if(NOT IS_DIRECTORY "${DIR}")
    message(FATAL_ERROR "Embed directory not found: ${DIR}")
  endif()

  file(GLOB_RECURSE _files RELATIVE "${DIR}" "${DIR}/*")

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
struct Asset { const char* path; const unsigned char* data; size_t size; };
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

    # Make a valid C symbol name from relative path
    string(REPLACE "/" "_" sym "${f}")
    string(REPLACE "\\" "_" sym "${sym}")
    string(REPLACE "." "_" sym "${sym}")
    string(REPLACE "-" "_" sym "${sym}")
    string(REPLACE " " "_" sym "${sym}")
    string(REPLACE ":" "_" sym "${sym}")

    file(READ "${_abs}" _hex HEX)
    string(LENGTH "${_hex}" _hex_len)

    if((_hex_len LESS 2) OR (NOT (_hex_len GREATER 0)))
      # Empty file: emit empty array
      file(APPEND "${_cpp}" "static const unsigned char data_${sym}[] = {};\n")
      file(APPEND "${_cpp}" "static const Asset asset_${sym} = {\"${f}\", data_${sym}, 0};\n\n")
      continue()
    endif()

    math(EXPR _nbytes "${_hex_len} / 2")
    if(_nbytes LESS 1)
      file(APPEND "${_cpp}" "static const unsigned char data_${sym}[] = {};\n")
      file(APPEND "${_cpp}" "static const Asset asset_${sym} = {\"${f}\", data_${sym}, 0};\n\n")
      continue()
    endif()

    math(EXPR _last "${_nbytes} - 1")

    file(APPEND "${_cpp}" "static const unsigned char data_${sym}[] = {\n  ")
    set(_col 0)

    foreach(i RANGE 0 ${_last})
      math(EXPR j "${i} * 2")
      string(SUBSTRING "${_hex}" ${j} 2 byte)

      if(byte STREQUAL "")
        message(FATAL_ERROR "Embed failed: empty byte for ${_abs} at index ${i} (hex_len=${_hex_len})")
      endif()

      file(APPEND "${_cpp}" "0x${byte},")
      math(EXPR _col "${_col} + 1")
      if(_col EQUAL 16)
        file(APPEND "${_cpp}" "\n  ")
        set(_col 0)
      endif()
    endforeach()

    file(APPEND "${_cpp}" "\n};\n")
    file(APPEND "${_cpp}" "static const Asset asset_${sym} = {\"${f}\", data_${sym}, sizeof(data_${sym})};\n\n")
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