import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const PREFIX = "scrypt";
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

// Public by design: this is only the record for the requested admin/admin gate.
// Deployments can replace it with PROXY_USERNAME_SCRYPT/PROXY_PASSWORD_SCRYPT.
export const DEFAULT_ADMIN_SCRYPT =
  "scrypt$16384$8$1$d2VibG94LWFkbWluLXNhbHQ=$zTtKVvlqEqT4gZdGOeasTWgsKm0SdNYFlROJIX8bXPI=";

export function makeCredential(password, salt = randomBytes(16)) {
  const record = [
    PREFIX,
    N,
    R,
    P,
    salt.toString("base64"),
    scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P }).toString("base64"),
  ];
  return record.join("$");
}

export function verifyCredential(password, record) {
  try {
    const [scheme, n, r, p, saltText, hashText] = String(record).split("$");
    if (scheme !== PREFIX || !n || !r || !p || !saltText || !hashText) return false;
    const salt = Buffer.from(saltText, "base64");
    const expected = Buffer.from(hashText, "base64");
    const actual = scryptSync(String(password), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function verifyLogin(username, password, env = process.env) {
  const userRecord = env.PROXY_USERNAME_SCRYPT || DEFAULT_ADMIN_SCRYPT;
  const passwordRecord = env.PROXY_PASSWORD_SCRYPT || DEFAULT_ADMIN_SCRYPT;
  return verifyCredential(username, userRecord) && verifyCredential(password, passwordRecord);
}
