import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const HASH_PREFIX = "scrypt-v1";
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export function hashPassword(password: string, salt = randomBytes(SALT_BYTES)): string {
  const derived = scryptSync(password, salt, KEY_BYTES);
  return `${HASH_PREFIX}:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [prefix, encodedSalt, encodedKey, extra] = encoded.split(":");
    if (prefix !== HASH_PREFIX || !encodedSalt || !encodedKey || extra !== undefined) return false;
    const salt = Buffer.from(encodedSalt, "base64url");
    const expected = Buffer.from(encodedKey, "base64url");
    if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

interface LoginAttempt {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

export class LoginAttemptLimiter {
  private readonly attempts = new Map<string, LoginAttempt>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 5 * 60_000,
    private readonly blockMs = 15 * 60_000,
  ) {}

  retryAfterSeconds(key: string, now = Date.now()): number {
    const attempt = this.attempts.get(key);
    if (!attempt) return 0;
    if (attempt.blockedUntil > now) return Math.ceil((attempt.blockedUntil - now) / 1_000);
    if (now - attempt.firstFailureAt >= this.windowMs) this.attempts.delete(key);
    return 0;
  }

  recordFailure(key: string, now = Date.now()): number {
    const previous = this.attempts.get(key);
    const attempt = !previous || now - previous.firstFailureAt >= this.windowMs
      ? { failures: 0, firstFailureAt: now, blockedUntil: 0 }
      : previous;
    attempt.failures += 1;
    if (attempt.failures >= this.maxFailures) attempt.blockedUntil = now + this.blockMs;
    this.attempts.set(key, attempt);
    this.prune(now);
    return attempt.blockedUntil > now ? Math.ceil((attempt.blockedUntil - now) / 1_000) : 0;
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  private prune(now: number): void {
    if (this.attempts.size <= 1_000) return;
    for (const [key, attempt] of this.attempts) {
      if (attempt.blockedUntil <= now && now - attempt.firstFailureAt >= this.windowMs) this.attempts.delete(key);
    }
  }
}
