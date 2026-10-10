# The patch step of the rapidjson FetchContent dependency (src/CMakeLists.txt). It runs in the source
# directory of rapidjson and may run again on a source that it already patched.
#
# rapidjson's GenericStringRef declares a copy assignment that it never defines, or (older revisions)
# defines one that assigns a const member, which GCC 14 refuses. Both become "= delete", the C++11 form.
set(_document "include/rapidjson/document.h")
file(READ "${_document}" _text)
set(_deleted "GenericStringRef& operator=(const GenericStringRef& rhs) = delete;")
set(_declared "GenericStringRef& operator=(const GenericStringRef& rhs) /* = delete */;")
set(_historical "GenericStringRef& operator=(const GenericStringRef& rhs) { s = rhs.s; length = rhs.length; }")

string(FIND "${_text}" "${_deleted}" _at_deleted)
string(FIND "${_text}" "${_declared}" _at_declared)
string(FIND "${_text}" "${_historical}" _at_historical)
if (NOT _at_deleted EQUAL -1)
  message(STATUS "rapidjson: GenericStringRef assignment already deleted")
elseif (NOT _at_declared EQUAL -1)
  string(REPLACE "${_declared}" "${_deleted}" _text "${_text}")
  file(WRITE "${_document}" "${_text}")
  message(STATUS "rapidjson: GenericStringRef assignment deleted")
elseif (NOT _at_historical EQUAL -1)
  string(REPLACE "${_historical}" "${_deleted}" _text "${_text}")
  file(WRITE "${_document}" "${_text}")
  message(STATUS "rapidjson: historical GenericStringRef assignment deleted")
else()
  message(FATAL_ERROR "rapidjson: the GenericStringRef assignment is not in an expected form (${_document})")
endif()
