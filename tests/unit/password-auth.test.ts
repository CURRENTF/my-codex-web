import { describe, expect, it } from "vitest";
import { hashPassword, LoginAttemptLimiter, verifyPassword } from "../../apps/server/src/password-auth";

describe("Web UI password authentication", () => {
  it("stores a salted scrypt hash and verifies without exposing the password", () => {
    const hash = hashPassword("test-password", Buffer.alloc(16, 7));
    expect(hash).toMatch(/^scrypt-v1:/);
    expect(hash).not.toContain("test-password");
    expect(verifyPassword("test-password", hash)).toBe(true);
    expect(verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("rejects malformed hashes without throwing", () => {
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "scrypt-v1:not-base64:not-base64")).toBe(false);
    expect(verifyPassword("anything", "another-format:a:b")).toBe(false);
  });

  it("blocks repeated failures per source and clears the state after success", () => {
    const limiter = new LoginAttemptLimiter(3, 1_000, 5_000);
    expect(limiter.recordFailure("client", 100)).toBe(0);
    expect(limiter.recordFailure("client", 200)).toBe(0);
    expect(limiter.recordFailure("client", 300)).toBe(5);
    expect(limiter.retryAfterSeconds("client", 1_300)).toBe(4);
    limiter.recordSuccess("client");
    expect(limiter.retryAfterSeconds("client", 1_300)).toBe(0);
  });
});
