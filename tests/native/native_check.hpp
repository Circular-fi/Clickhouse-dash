#pragma once

// The checks of the native tests (tests/native): CHECK, CHECK_EQ and RUN count into g_checks and g_failures; a test binary ends with
//   std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl; return g_failures == 0 ? 0 : 1;

#include <exception>
#include <iostream>

inline int g_failures = 0;
inline int g_checks = 0;

#define CHECK(cond)                                                                        \
  do {                                                                                     \
    ++g_checks;                                                                            \
    if (!(cond)) {                                                                         \
      ++g_failures;                                                                        \
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK failed: " #cond << std::endl;   \
    }                                                                                      \
  } while (0)

#define CHECK_EQ(a, b)                                                                                   \
  do {                                                                                                   \
    ++g_checks;                                                                                          \
    const auto va = (a);                                                                                 \
    const auto vb = (b);                                                                                 \
    if (!(va == vb)) {                                                                                   \
      ++g_failures;                                                                                      \
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK_EQ failed: " #a " == " #b << "\n  left : " << va \
                << "\n  right: " << vb << std::endl;                                                     \
    }                                                                                                    \
  } while (0)

// A test that throws is a failure with its name (a sanitizer finding stops the run anyway).
#define RUN(test)                                                                           \
  do {                                                                                      \
    try {                                                                                   \
      test();                                                                               \
    } catch (const std::exception& e) {                                                     \
      ++g_failures;                                                                         \
      std::cerr << #test << ": threw " << e.what() << std::endl;                            \
    }                                                                                       \
  } while (0)
