#include "jwt.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <array>
#include <cstring>
#include <sstream>

namespace chdash {
namespace {

// --- Base64URL ---
static const char* B64URL_ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

static std::string b64url_encode(const uint8_t* data, size_t n) {
  std::string out;
  out.reserve(((n + 2) / 3) * 4);

  size_t i = 0;
  while (i + 3 <= n) {
    uint32_t v = (uint32_t(data[i]) << 16) | (uint32_t(data[i + 1]) << 8) | uint32_t(data[i + 2]);
    out.push_back(B64URL_ALPH[(v >> 18) & 63]);
    out.push_back(B64URL_ALPH[(v >> 12) & 63]);
    out.push_back(B64URL_ALPH[(v >> 6) & 63]);
    out.push_back(B64URL_ALPH[v & 63]);
    i += 3;
  }

  const size_t rem = n - i;
  if (rem == 1) {
    uint32_t v = (uint32_t(data[i]) << 16);
    out.push_back(B64URL_ALPH[(v >> 18) & 63]);
    out.push_back(B64URL_ALPH[(v >> 12) & 63]);
    // no padding in base64url
  } else if (rem == 2) {
    uint32_t v = (uint32_t(data[i]) << 16) | (uint32_t(data[i + 1]) << 8);
    out.push_back(B64URL_ALPH[(v >> 18) & 63]);
    out.push_back(B64URL_ALPH[(v >> 12) & 63]);
    out.push_back(B64URL_ALPH[(v >> 6) & 63]);
  }
  return out;
}

static int b64url_val(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-') return 62;
  if (c == '_') return 63;
  return -1;
}

static bool b64url_decode(const std::string& in, std::vector<uint8_t>& out) {
  out.clear();
  if (in.empty()) return true;

  // base64url has no padding. We'll decode in 4-char groups.
  size_t i = 0;
  while (i < in.size()) {
    const size_t remain = in.size() - i;
    if (remain == 1) return false;

    int v0 = b64url_val(in[i]);
    int v1 = b64url_val(in[i + 1]);
    if (v0 < 0 || v1 < 0) return false;

    if (remain == 2) {
      uint32_t v = (uint32_t(v0) << 18) | (uint32_t(v1) << 12);
      out.push_back(uint8_t((v >> 16) & 0xFF));
      return true;
    }

    int v2 = b64url_val(in[i + 2]);
    if (v2 < 0) return false;

    if (remain == 3) {
      uint32_t v = (uint32_t(v0) << 18) | (uint32_t(v1) << 12) | (uint32_t(v2) << 6);
      out.push_back(uint8_t((v >> 16) & 0xFF));
      out.push_back(uint8_t((v >> 8) & 0xFF));
      return true;
    }

    int v3 = b64url_val(in[i + 3]);
    if (v3 < 0) return false;
    uint32_t v = (uint32_t(v0) << 18) | (uint32_t(v1) << 12) | (uint32_t(v2) << 6) | uint32_t(v3);
    out.push_back(uint8_t((v >> 16) & 0xFF));
    out.push_back(uint8_t((v >> 8) & 0xFF));
    out.push_back(uint8_t(v & 0xFF));
    i += 4;
  }
  return true;
}

static bool constant_time_eq(const uint8_t* a, const uint8_t* b, size_t n) {
  uint8_t x = 0;
  for (size_t i = 0; i < n; ++i) x |= (a[i] ^ b[i]);
  return x == 0;
}

// --- SHA-256 (minimal implementation) ---
// Public domain / educational implementation.
// Inspired by FIPS 180-4 reference.

static inline uint32_t rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); }
static inline uint32_t ch(uint32_t x, uint32_t y, uint32_t z) { return (x & y) ^ (~x & z); }
static inline uint32_t maj(uint32_t x, uint32_t y, uint32_t z) { return (x & y) ^ (x & z) ^ (y & z); }
static inline uint32_t bsig0(uint32_t x) { return rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22); }
static inline uint32_t bsig1(uint32_t x) { return rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25); }
static inline uint32_t ssig0(uint32_t x) { return rotr(x, 7) ^ rotr(x, 18) ^ (x >> 3); }
static inline uint32_t ssig1(uint32_t x) { return rotr(x, 17) ^ rotr(x, 19) ^ (x >> 10); }

static const uint32_t K[64] = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};

static std::array<uint8_t, 32> sha256(const uint8_t* data, size_t len) {
  uint32_t h0 = 0x6a09e667;
  uint32_t h1 = 0xbb67ae85;
  uint32_t h2 = 0x3c6ef372;
  uint32_t h3 = 0xa54ff53a;
  uint32_t h4 = 0x510e527f;
  uint32_t h5 = 0x9b05688c;
  uint32_t h6 = 0x1f83d9ab;
  uint32_t h7 = 0x5be0cd19;

  // Pre-processing: padding
  const uint64_t bit_len = static_cast<uint64_t>(len) * 8ull;
  // new_len = len + 1 + pad + 8, multiple of 64
  size_t new_len = len + 1 + 8;
  size_t rem = new_len % 64;
  if (rem != 0) new_len += (64 - rem);

  std::vector<uint8_t> msg(new_len, 0);
  if (len > 0) std::memcpy(msg.data(), data, len);
  msg[len] = 0x80;
  // length in bits at end (big endian)
  for (int i = 0; i < 8; ++i) {
    msg[new_len - 1 - i] = uint8_t((bit_len >> (8 * i)) & 0xFF);
  }

  // Process in 512-bit chunks
  uint32_t w[64];
  for (size_t off = 0; off < new_len; off += 64) {
    // prepare message schedule
    for (int t = 0; t < 16; ++t) {
      size_t j = off + t * 4;
      w[t] = (uint32_t(msg[j]) << 24) | (uint32_t(msg[j + 1]) << 16) | (uint32_t(msg[j + 2]) << 8) | uint32_t(msg[j + 3]);
    }
    for (int t = 16; t < 64; ++t) {
      w[t] = ssig1(w[t - 2]) + w[t - 7] + ssig0(w[t - 15]) + w[t - 16];
    }

    uint32_t a = h0;
    uint32_t b = h1;
    uint32_t c = h2;
    uint32_t d = h3;
    uint32_t e = h4;
    uint32_t f = h5;
    uint32_t g = h6;
    uint32_t h = h7;

    for (int t = 0; t < 64; ++t) {
      uint32_t t1 = h + bsig1(e) + ch(e, f, g) + K[t] + w[t];
      uint32_t t2 = bsig0(a) + maj(a, b, c);
      h = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }

    h0 += a;
    h1 += b;
    h2 += c;
    h3 += d;
    h4 += e;
    h5 += f;
    h6 += g;
    h7 += h;
  }

  std::array<uint8_t, 32> out{};
  auto put = [&](int idx, uint32_t v) {
    out[idx * 4 + 0] = uint8_t((v >> 24) & 0xFF);
    out[idx * 4 + 1] = uint8_t((v >> 16) & 0xFF);
    out[idx * 4 + 2] = uint8_t((v >> 8) & 0xFF);
    out[idx * 4 + 3] = uint8_t(v & 0xFF);
  };
  put(0, h0); put(1, h1); put(2, h2); put(3, h3);
  put(4, h4); put(5, h5); put(6, h6); put(7, h7);
  return out;
}

static std::array<uint8_t, 32> hmac_sha256(const uint8_t* key, size_t key_len, const uint8_t* msg, size_t msg_len) {
  // HMAC(K, m) = SHA256((K0 xor opad) || SHA256((K0 xor ipad) || m))
  const size_t block_size = 64;
  std::array<uint8_t, block_size> k0{};
  if (key_len > block_size) {
    auto hk = sha256(key, key_len);
    std::memcpy(k0.data(), hk.data(), hk.size());
  } else {
    if (key_len > 0) std::memcpy(k0.data(), key, key_len);
  }

  std::array<uint8_t, block_size> ipad{};
  std::array<uint8_t, block_size> opad{};
  for (size_t i = 0; i < block_size; ++i) {
    ipad[i] = uint8_t(k0[i] ^ 0x36);
    opad[i] = uint8_t(k0[i] ^ 0x5c);
  }

  std::vector<uint8_t> inner;
  inner.reserve(block_size + msg_len);
  inner.insert(inner.end(), ipad.begin(), ipad.end());
  inner.insert(inner.end(), msg, msg + msg_len);
  auto inner_hash = sha256(inner.data(), inner.size());

  std::vector<uint8_t> outer;
  outer.reserve(block_size + inner_hash.size());
  outer.insert(outer.end(), opad.begin(), opad.end());
  outer.insert(outer.end(), inner_hash.begin(), inner_hash.end());
  return sha256(outer.data(), outer.size());
}

static std::string json_stringify(const rapidjson::Value& v) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  v.Accept(w);
  return sb.GetString();
}

} // namespace

JwtService::JwtService(std::vector<uint8_t> secret) : secret_(std::move(secret)) {}

std::string JwtService::sign_cancel_token(const JwtClaims& c) const {
  // Header
  rapidjson::Document header;
  header.SetObject();
  auto& ha = header.GetAllocator();
  header.AddMember("alg", "HS256", ha);
  header.AddMember("typ", "JWT", ha);

  // Payload
  rapidjson::Document payload;
  payload.SetObject();
  auto& pa = payload.GetAllocator();
  payload.AddMember("qid", rapidjson::Value(c.query_id.c_str(), pa), pa);
  payload.AddMember("hid", rapidjson::Value(c.host_id.c_str(), pa), pa);
  payload.AddMember("iat", c.issued_at_unix, pa);

  const std::string header_json = json_stringify(header);
  const std::string payload_json = json_stringify(payload);

  const std::string header_b64 = b64url_encode(reinterpret_cast<const uint8_t*>(header_json.data()), header_json.size());
  const std::string payload_b64 = b64url_encode(reinterpret_cast<const uint8_t*>(payload_json.data()), payload_json.size());

  std::string signing_input = header_b64 + "." + payload_b64;

  auto sig = hmac_sha256(secret_.data(), secret_.size(), reinterpret_cast<const uint8_t*>(signing_input.data()), signing_input.size());
  const std::string sig_b64 = b64url_encode(sig.data(), sig.size());
  return signing_input + "." + sig_b64;
}

std::optional<JwtClaims> JwtService::verify_cancel_token(const std::string& token) const {
  // Split into three parts
  size_t p1 = token.find('.');
  if (p1 == std::string::npos) return std::nullopt;
  size_t p2 = token.find('.', p1 + 1);
  if (p2 == std::string::npos) return std::nullopt;

  const std::string h64 = token.substr(0, p1);
  const std::string p64 = token.substr(p1 + 1, p2 - (p1 + 1));
  const std::string s64 = token.substr(p2 + 1);
  if (h64.empty() || p64.empty() || s64.empty()) return std::nullopt;

  // Decode header
  std::vector<uint8_t> hb;
  if (!b64url_decode(h64, hb)) return std::nullopt;
  rapidjson::Document hd;
  hd.Parse(reinterpret_cast<const char*>(hb.data()), hb.size());
  if (hd.HasParseError() || !hd.IsObject()) return std::nullopt;
  if (!hd.HasMember("alg") || !hd["alg"].IsString()) return std::nullopt;
  if (std::string(hd["alg"].GetString()) != "HS256") return std::nullopt;

  // Verify signature
  std::string signing_input = h64 + "." + p64;
  auto sig = hmac_sha256(secret_.data(), secret_.size(), reinterpret_cast<const uint8_t*>(signing_input.data()), signing_input.size());
  std::string expected_b64 = b64url_encode(sig.data(), sig.size());
  if (expected_b64.size() != s64.size()) return std::nullopt;
  if (!constant_time_eq(reinterpret_cast<const uint8_t*>(expected_b64.data()), reinterpret_cast<const uint8_t*>(s64.data()), expected_b64.size())) return std::nullopt;

  // Decode payload
  std::vector<uint8_t> pb;
  if (!b64url_decode(p64, pb)) return std::nullopt;
  rapidjson::Document pd;
  pd.Parse(reinterpret_cast<const char*>(pb.data()), pb.size());
  if (pd.HasParseError() || !pd.IsObject()) return std::nullopt;

  if (!pd.HasMember("qid") || !pd["qid"].IsString()) return std::nullopt;
  if (!pd.HasMember("hid") || !pd["hid"].IsString()) return std::nullopt;

  JwtClaims c;
  c.query_id = pd["qid"].GetString();
  c.host_id = pd["hid"].GetString();
  if (pd.HasMember("iat") && pd["iat"].IsInt64()) c.issued_at_unix = pd["iat"].GetInt64();
  return c;
}

} // namespace chdash
