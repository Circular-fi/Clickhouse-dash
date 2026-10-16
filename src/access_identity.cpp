#include "access_identity.hpp"

#include "jwt.hpp"
#include "json_parse.hpp"

#include <rapidjson/document.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <iterator>

namespace chdash {
namespace {

constexpr size_t kMaxTokenBytes = 8192;
constexpr size_t kMaxSubjectBytes = 256;
constexpr size_t kMaxKeys = 16;

// The DER prefixes of a SubjectPublicKeyInfo: Ed25519 (RFC 8410), then P-256 with an uncompressed point (RFC 5480).
constexpr uint8_t kEd25519Prefix[] = {0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00};
constexpr uint8_t kP256Prefix[] = {0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06,
                                   0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04};

int base64_value(char c, bool url) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (url) {
    if (c == '-') return 62;
    if (c == '_') return 63;
  } else {
    if (c == '+') return 62;
    if (c == '/') return 63;
  }
  return -1;
}

// Base64 (standard alphabet with `=` padding, or base64url without padding). False for any other character, for a length
// that cannot be, and for padding in the url form.
bool base64_decode(std::string_view in, bool url, std::vector<uint8_t>& out) {
  out.clear();
  if (!url) {
    if (in.size() % 4 != 0) return false;
    size_t pad = 0;
    while (pad < 2 && !in.empty() && in.back() == '=') {
      in.remove_suffix(1);
      ++pad;
    }
  }
  if (in.size() % 4 == 1) return false;
  out.reserve(in.size() * 3 / 4);
  uint32_t buffer = 0;
  int bits = 0;
  for (const char c : in) {
    const int value = base64_value(c, url);
    if (value < 0) return false;
    buffer = (buffer << 6) | static_cast<uint32_t>(value);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<uint8_t>((buffer >> bits) & 0xff));
    }
  }
  return true;
}

std::string base64url_encode(const uint8_t* data, size_t size) {
  static constexpr char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string out;
  uint32_t buffer = 0;
  int bits = 0;
  for (size_t i = 0; i < size; ++i) {
    buffer = (buffer << 8) | data[i];
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out.push_back(kAlphabet[(buffer >> bits) & 63]);
    }
  }
  if (bits > 0) out.push_back(kAlphabet[(buffer << (6 - bits)) & 63]);
  return out;
}

std::string thumbprint(const std::string& jwk) {
  const auto digest = sha256_digest(reinterpret_cast<const uint8_t*>(jwk.data()), jwk.size());
  return base64url_encode(digest.data(), digest.size());
}

std::string_view trim(std::string_view text) {
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t' || text.front() == '\r')) text.remove_prefix(1);
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t' || text.back() == '\r')) text.remove_suffix(1);
  return text;
}

bool has_control(std::string_view text) {
  return std::any_of(text.begin(), text.end(), [](unsigned char c) { return c < 0x20 || c == 0x7f; });
}

// A NumericDate (RFC 7519): an integer or a number of seconds. nullopt for any other value.
std::optional<int64_t> numeric_date(const rapidjson::Value& value) {
  if (value.IsInt64()) return value.GetInt64();
  if (value.IsUint64()) return std::nullopt;  // larger than int64: not a date
  if (value.IsNumber()) {
    const double seconds = value.GetDouble();
    if (!std::isfinite(seconds) || std::fabs(seconds) > 9.0e15) return std::nullopt;
    return static_cast<int64_t>(std::floor(seconds));
  }
  return std::nullopt;
}

IdentityResult refused(const char* reason) {
  IdentityResult out;
  out.reason = reason;
  return out;
}

} // namespace

const char* identity_key_type_name(IdentityKey::Type type) { return type == IdentityKey::Type::Ed25519 ? "Ed25519" : "P-256"; }

std::optional<std::vector<IdentityKey>> parse_identity_public_keys(std::string_view pem, std::string* error) {
  const auto fail = [&](std::string message) -> std::optional<std::vector<IdentityKey>> {
    if (error) *error = std::move(message);
    return std::nullopt;
  };
  std::vector<IdentityKey> keys;
  bool inside = false;
  std::string body;
  size_t line_number = 0;
  size_t start = 0;
  while (start <= pem.size()) {
    size_t end = pem.find('\n', start);
    if (end == std::string_view::npos) end = pem.size();
    const std::string_view line = trim(pem.substr(start, end - start));
    ++line_number;
    start = end + 1;
    if (!inside) {
      if (line.empty()) continue;
      if (line != "-----BEGIN PUBLIC KEY-----") {
        return fail("line " + std::to_string(line_number) + " is not -----BEGIN PUBLIC KEY----- (only public keys in PEM are accepted)");
      }
      inside = true;
      body.clear();
      continue;
    }
    if (line != "-----END PUBLIC KEY-----") {
      body.append(line.data(), line.size());
      if (body.size() > 4096) return fail("key " + std::to_string(keys.size() + 1) + " is too long for an Ed25519 or a P-256 public key");
      continue;
    }
    inside = false;
    const size_t index = keys.size() + 1;
    std::vector<uint8_t> der;
    if (!base64_decode(body, false, der)) return fail("key " + std::to_string(index) + " is not valid base64");
    IdentityKey key;
    if (der.size() == sizeof(kEd25519Prefix) + 32 && std::memcmp(der.data(), kEd25519Prefix, sizeof(kEd25519Prefix)) == 0) {
      key.type = IdentityKey::Type::Ed25519;
      std::memcpy(key.ed25519.data(), der.data() + sizeof(kEd25519Prefix), 32);
      key.kid = thumbprint(R"({"crv":"Ed25519","kty":"OKP","x":")" + base64url_encode(key.ed25519.data(), 32) + "\"}");
    } else if (der.size() == sizeof(kP256Prefix) + 64 && std::memcmp(der.data(), kP256Prefix, sizeof(kP256Prefix)) == 0) {
      key.type = IdentityKey::Type::P256;
      std::memcpy(key.p256.data(), der.data() + sizeof(kP256Prefix), 64);
      if (!p256_public_key_valid(key.p256)) return fail("key " + std::to_string(index) + " is not a point of the curve P-256");
      key.kid = thumbprint(R"({"crv":"P-256","kty":"EC","x":")" + base64url_encode(key.p256.data(), 32) + R"(","y":")" +
                           base64url_encode(key.p256.data() + 32, 32) + "\"}");
    } else {
      return fail("key " + std::to_string(index) +
                  " is not an Ed25519 public key or a P-256 public key with an uncompressed point (SubjectPublicKeyInfo)");
    }
    if (keys.size() >= kMaxKeys) return fail("more than " + std::to_string(kMaxKeys) + " keys");
    keys.push_back(std::move(key));
  }
  if (inside) return fail("-----END PUBLIC KEY----- is missing");
  if (keys.empty()) return fail("no key: give at least one -----BEGIN PUBLIC KEY----- block");
  return keys;
}

IdentityVerifier::IdentityVerifier(IdentityVerifierOptions options) : options_(std::move(options)) {}

IdentityResult IdentityVerifier::verify(std::string_view token, int64_t now_unix) const {
  if (token.empty()) return refused("missing");
  if (token.size() > kMaxTokenBytes) return refused("malformed");
  std::string cache_key;
  if (options_.cache_entries > 0) {
    const auto digest = sha256_digest(reinterpret_cast<const uint8_t*>(token.data()), token.size());
    cache_key.assign(reinterpret_cast<const char*>(digest.data()), digest.size());
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = cache_.find(cache_key);
    if (it != cache_.end()) {
      if (now_unix < it->second.expires_at) {
        IdentityResult out;
        out.ok = true;
        out.subject = it->second.subject;
        out.expires_at = it->second.expires_at;
        return out;
      }
      cache_.erase(it);
      return refused("expired");
    }
  }
  IdentityResult result = verify_uncached(token, now_unix);
  if (result.ok && options_.cache_entries > 0) {
    std::lock_guard<std::mutex> lock(mu_);
    if (cache_.size() >= options_.cache_entries) {
      for (auto it = cache_.begin(); it != cache_.end();) it = it->second.expires_at <= now_unix ? cache_.erase(it) : std::next(it);
      if (cache_.size() >= options_.cache_entries) cache_.clear();
    }
    cache_[cache_key] = Cached{result.subject, result.expires_at};
  }
  return result;
}

IdentityResult IdentityVerifier::verify_uncached(std::string_view token, int64_t now_unix) const {
  const size_t first = token.find('.');
  if (first == std::string_view::npos) return refused("malformed");
  const size_t second = token.find('.', first + 1);
  if (second == std::string_view::npos || token.find('.', second + 1) != std::string_view::npos) return refused("malformed");
  const std::string_view header_text = token.substr(0, first);
  const std::string_view payload_text = token.substr(first + 1, second - first - 1);
  const std::string_view signature_text = token.substr(second + 1);
  const std::string_view signing_input = token.substr(0, second);

  std::vector<uint8_t> header_bytes, payload_bytes, signature;
  if (header_text.empty() || payload_text.empty() || !base64_decode(header_text, true, header_bytes) ||
      !base64_decode(payload_text, true, payload_bytes) || !base64_decode(signature_text, true, signature)) {
    return refused("malformed");
  }

  rapidjson::Document header;
  if (!parse_json_bounded(header, std::string_view(reinterpret_cast<const char*>(header_bytes.data()), header_bytes.size())) ||
      !header.IsObject()) {
    return refused("malformed");
  }
  const auto alg = header.FindMember("alg");
  if (alg == header.MemberEnd() || !alg->value.IsString()) return refused("algorithm");
  const std::string algorithm(alg->value.GetString(), alg->value.GetStringLength());
  if (algorithm != "EdDSA" && algorithm != "ES256") return refused("algorithm");
  const IdentityKey::Type type = algorithm == "EdDSA" ? IdentityKey::Type::Ed25519 : IdentityKey::Type::P256;
  // An extension that this verifier does not know must stop the token (RFC 7515, 4.1.11).
  if (header.HasMember("crit")) return refused("malformed");
  if (const auto typ = header.FindMember("typ"); typ != header.MemberEnd()) {
    if (!typ->value.IsString()) return refused("malformed");
    std::string value(typ->value.GetString(), typ->value.GetStringLength());
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    if (value != "JWT") return refused("malformed");
  }

  bool signed_ok = false;
  for (const IdentityKey& key : options_.keys) {
    if (key.type != type) continue;
    signed_ok = type == IdentityKey::Type::Ed25519 ? ed25519_verify(key.ed25519, signing_input, signature.data(), signature.size())
                                                   : es256_verify(key.p256, signing_input, signature.data(), signature.size());
    if (signed_ok) break;
  }
  if (!signed_ok) return refused("signature");

  rapidjson::Document claims;
  if (!parse_json_bounded(claims, std::string_view(reinterpret_cast<const char*>(payload_bytes.data()), payload_bytes.size())) ||
      !claims.IsObject()) {
    return refused("malformed");
  }
  const auto iss = claims.FindMember("iss");
  if (iss == claims.MemberEnd() || !iss->value.IsString() ||
      std::string_view(iss->value.GetString(), iss->value.GetStringLength()) != options_.issuer) {
    return refused("issuer");
  }
  const auto aud = claims.FindMember("aud");
  bool audience_ok = false;
  if (aud != claims.MemberEnd()) {
    if (aud->value.IsString()) {
      audience_ok = std::string_view(aud->value.GetString(), aud->value.GetStringLength()) == options_.audience;
    } else if (aud->value.IsArray()) {
      for (const auto& item : aud->value.GetArray()) {
        if (item.IsString() && std::string_view(item.GetString(), item.GetStringLength()) == options_.audience) audience_ok = true;
      }
    }
  }
  if (!audience_ok) return refused("audience");

  const auto exp_member = claims.FindMember("exp");
  const auto iat_member = claims.FindMember("iat");
  if (exp_member == claims.MemberEnd() || iat_member == claims.MemberEnd()) return refused("max_age");
  const auto exp = numeric_date(exp_member->value);
  const auto iat = numeric_date(iat_member->value);
  if (!exp || !iat) return refused("malformed");
  if (now_unix >= *exp) return refused("expired");
  if (*iat > now_unix + options_.clock_skew_s) return refused("not_yet_valid");
  // The claims are whole seconds: a life of d seconds is at most max_age_ms when d <= max_age_ms / 1000 (the division rounds down).
  if (*exp < *iat || (*exp - *iat) > options_.max_age_ms / 1000) return refused("max_age");
  if (const auto nbf_member = claims.FindMember("nbf"); nbf_member != claims.MemberEnd()) {
    const auto nbf = numeric_date(nbf_member->value);
    if (!nbf) return refused("malformed");
    if (*nbf > now_unix + options_.clock_skew_s) return refused("not_yet_valid");
  }

  const auto sub = claims.FindMember("sub");
  if (sub == claims.MemberEnd() || !sub->value.IsString()) return refused("subject");
  const std::string_view subject(sub->value.GetString(), sub->value.GetStringLength());
  if (subject.empty() || subject.size() > kMaxSubjectBytes || has_control(subject)) return refused("subject");

  IdentityResult out;
  out.ok = true;
  out.subject.assign(subject.data(), subject.size());
  out.expires_at = *exp;
  return out;
}

} // namespace chdash
