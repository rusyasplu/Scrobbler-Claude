/* MD5 (подпись запросов Last.fm) и SHA-256 (PKCE-вход в Spotify) на чистом JS: в браузере MD5 нет, а crypto.subtle асинхронный. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Hash = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function utf8(str) { return new TextEncoder().encode(str); }
  function rotl(x, n) { return (x << n) | (x >>> (32 - n)); }
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  /** Дополняет сообщение до кратного 64 байтам: 0x80, нули, длина в битах (little- или big-endian). */
  function pad(bytes, bigEndian) {
    var len = bytes.length;
    var total = (((len + 8) >>> 6) + 1) << 6;
    var out = new Uint8Array(total);
    out.set(bytes);
    out[len] = 0x80;
    var lo = (len << 3) >>> 0;
    var hi = Math.floor(len / 536870912);   // len * 8 / 2^32
    var v = new DataView(out.buffer);
    if (bigEndian) { v.setUint32(total - 8, hi, false); v.setUint32(total - 4, lo, false); }
    else { v.setUint32(total - 8, lo, true); v.setUint32(total - 4, hi, true); }
    return out;
  }

  var MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  var MD5_K = [];
  for (var i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

  function md5(str) {
    var m = pad(utf8(str), false);
    var view = new DataView(m.buffer);
    var a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for (var off = 0; off < m.length; off += 64) {
      var a = a0, b = b0, c = c0, d = d0;
      for (var j = 0; j < 64; j++) {
        var f, g;
        if (j < 16) { f = (b & c) | (~b & d); g = j; }
        else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
        else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * j) % 16; }
        f = (f + a + MD5_K[j] + view.getUint32(off + g * 4, true)) | 0;
        a = d; d = c; c = b;
        b = (b + rotl(f, MD5_S[j])) | 0;
      }
      a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
    }
    var out = new DataView(new ArrayBuffer(16));
    out.setUint32(0, a0, true); out.setUint32(4, b0, true); out.setUint32(8, c0, true); out.setUint32(12, d0, true);
    var hex = "";
    for (var k = 0; k < 16; k++) hex += (out.getUint8(k) + 256).toString(16).slice(1);
    return hex;
  }

  var SHA_K = [], SHA_H = [];
  (function () {
    var primes = [], n = 2;
    while (primes.length < 64) {
      var isPrime = true;
      for (var p = 0; p < primes.length && primes[p] * primes[p] <= n; p++) if (n % primes[p] === 0) { isPrime = false; break; }
      if (isPrime) primes.push(n);
      n++;
    }
    for (var i = 0; i < 64; i++) SHA_K[i] = Math.floor((Math.cbrt(primes[i]) % 1) * 4294967296) >>> 0;
    for (var h = 0; h < 8; h++) SHA_H[h] = Math.floor((Math.sqrt(primes[h]) % 1) * 4294967296) >>> 0;
  })();

  /** SHA-256 -> байты (Uint8Array из 32 элементов). */
  function sha256Bytes(str) {
    var m = pad(utf8(str), true);
    var view = new DataView(m.buffer);
    var H = SHA_H.slice();
    var w = new Array(64);
    for (var off = 0; off < m.length; off += 64) {
      for (var t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4, false);
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + SHA_K[t] + w[t]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32), ov = new DataView(out.buffer);
    for (var i = 0; i < 8; i++) ov.setUint32(i * 4, H[i], false);
    return out;
  }

  /** SHA-256 в base64url без «=» — так Spotify ждёт code_challenge. */
  function sha256(str) {
    var bytes = sha256Bytes(str), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  return { md5: md5, sha256: sha256 };
});
