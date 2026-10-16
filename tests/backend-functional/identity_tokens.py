"""Test identity tokens for the access of humans (docs/access.md, contract 11.3).

The tests image has no cryptography package, so this module signs with the reference algorithms in pure Python:
Ed25519 (RFC 8032, section 6) and ECDSA on P-256 with SHA-256 and a deterministic nonce (RFC 6979). It is slow and has no
protection against side channels: it is for test keys only. The server verifies the tokens with its own code.

    key = Ed25519Key(seed)          # 32 bytes
    key = P256Key(secret)           # an integer in [1, n-1]
    key.public_pem()                # the SubjectPublicKeyInfo in PEM, for access.identity.public_keys
    make_token(key, claims)         # a compact JWS: EdDSA or ES256
"""

import base64
import hashlib
import hmac
import json

# ---- Ed25519 (RFC 8032) ---------------------------------------------------------------------------------------------------

_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _ed_add(a, b):
    x1, y1, z1, t1 = a
    x2, y2, z2, t2 = b
    aa = (y1 - x1) * (y2 - x2) % _P
    bb = (y1 + x1) * (y2 + x2) % _P
    cc = 2 * t1 * t2 * _D % _P
    dd = 2 * z1 * z2 % _P
    e, f, g, h = bb - aa, dd - cc, dd + cc, bb + aa
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _ed_mul(s, point):
    q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            q = _ed_add(q, point)
        point = _ed_add(point, point)
        s >>= 1
    return q


def _ed_recover_x(y, sign):
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P)
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * _SQRT_M1 % _P
    if (x & 1) != sign:
        x = _P - x
    return x


_GY = 4 * pow(5, _P - 2, _P) % _P
_GX = _ed_recover_x(_GY, 0)
_G = (_GX, _GY, 1, _GX * _GY % _P)


def _ed_compress(point):
    x, y, z, _ = point
    zinv = pow(z, _P - 2, _P)
    x, y = x * zinv % _P, y * zinv % _P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _sha512_int(data):
    return int.from_bytes(hashlib.sha512(data).digest(), "little")


class Ed25519Key:
    alg = "EdDSA"

    def __init__(self, seed: bytes):
        assert len(seed) == 32
        digest = hashlib.sha512(seed).digest()
        a = int.from_bytes(digest[:32], "little")
        a &= (1 << 254) - 8
        a |= 1 << 254
        self._a = a
        self._prefix = digest[32:]
        self.public = _ed_compress(_ed_mul(a, _G))

    def sign(self, message: bytes) -> bytes:
        r = _sha512_int(self._prefix + message) % _L
        big_r = _ed_compress(_ed_mul(r, _G))
        h = _sha512_int(big_r + self.public + message) % _L
        s = (r + h * self._a) % _L
        return big_r + int.to_bytes(s, 32, "little")

    def public_pem(self) -> str:
        der = bytes.fromhex("302a300506032b6570032100") + self.public
        return _pem(der)


# ---- P-256 (ECDSA, RFC 6979) ----------------------------------------------------------------------------------------------

_P256_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_P256_A = _P256_P - 3
_P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_P256_G = (
    0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)


def _ec_add(p, q):
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0] and (p[1] + q[1]) % _P256_P == 0:
        return None
    if p == q:
        lam = (3 * p[0] * p[0] + _P256_A) * pow(2 * p[1], _P256_P - 2, _P256_P) % _P256_P
    else:
        lam = (q[1] - p[1]) * pow(q[0] - p[0], _P256_P - 2, _P256_P) % _P256_P
    x = (lam * lam - p[0] - q[0]) % _P256_P
    return (x, (lam * (p[0] - x) - p[1]) % _P256_P)


def _ec_mul(k, point):
    out = None
    while k > 0:
        if k & 1:
            out = _ec_add(out, point)
        point = _ec_add(point, point)
        k >>= 1
    return out


def _rfc6979_nonce(secret: int, digest: bytes) -> int:
    x = secret.to_bytes(32, "big")
    h = (int.from_bytes(digest, "big") % _P256_N).to_bytes(32, "big")
    v = b"\x01" * 32
    k = b"\x00" * 32
    k = hmac.new(k, v + b"\x00" + x + h, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    k = hmac.new(k, v + b"\x01" + x + h, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    while True:
        v = hmac.new(k, v, hashlib.sha256).digest()
        candidate = int.from_bytes(v, "big")
        if 1 <= candidate < _P256_N:
            return candidate
        k = hmac.new(k, v + b"\x00", hashlib.sha256).digest()
        v = hmac.new(k, v, hashlib.sha256).digest()


class P256Key:
    alg = "ES256"

    def __init__(self, secret: int):
        assert 1 <= secret < _P256_N
        self._d = secret
        self.point = _ec_mul(secret, _P256_G)

    def sign(self, message: bytes) -> bytes:
        digest = hashlib.sha256(message).digest()
        e = int.from_bytes(digest, "big")
        k = _rfc6979_nonce(self._d, digest)
        r = _ec_mul(k, _P256_G)[0] % _P256_N
        s = pow(k, _P256_N - 2, _P256_N) * (e + r * self._d) % _P256_N
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")

    def public_pem(self) -> str:
        der = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d03010703420004")
        der += self.point[0].to_bytes(32, "big") + self.point[1].to_bytes(32, "big")
        return _pem(der)


# ---- JWS ------------------------------------------------------------------------------------------------------------------


def _pem(der: bytes) -> str:
    body = base64.b64encode(der).decode()
    lines = [body[i : i + 64] for i in range(0, len(body), 64)]
    return "-----BEGIN PUBLIC KEY-----\n" + "\n".join(lines) + "\n-----END PUBLIC KEY-----\n"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_token(key, claims: dict, header: dict | None = None) -> str:
    head = {"alg": key.alg, "typ": "JWT"}
    if header:
        head.update(header)
    signing_input = b64url(json.dumps(head, separators=(",", ":")).encode()) + "." + b64url(json.dumps(claims, separators=(",", ":")).encode())
    return signing_input + "." + b64url(key.sign(signing_input.encode()))
