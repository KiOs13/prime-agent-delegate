import assert from "node:assert/strict";
import { test } from "node:test";
import { isSecretKey, sanitize, sanitizeString } from "../skill-source/scripts/sanitize.mjs";

test("redacts the exact structured secret keys recursively", () => {
	const keys = [
		"authorization", "apiKey", "api_key", "token", "access_token", "refresh_token",
		"password", "passwd", "secret", "cookie", "cookies", "set-cookie",
	];
	for (const key of keys) assert.equal(isSecretKey(key), true, key);
	assert.equal(isSecretKey("tokenCount"), false);

	const input = { safe: "ok", nested: { apiKey: "abc", values: [{ password: "p" }] } };
	assert.deepEqual(sanitize(input), {
		safe: "ok",
		nested: { apiKey: "[REDACTED]", values: [{ password: "[REDACTED]" }] },
	});
	assert.equal(input.nested.apiKey, "abc");
});

test("redacts authorization and key-value secrets inside strings", () => {
	const sanitized = sanitizeString(
		"Bearer abc Basic Zm9vOmJhcg== api_key=xyz token=tok-secret password: hunter2 safe=value",
	);
	for (const secret of ["abc", "Zm9vOmJhcg==", "xyz", "token=tok-secret", "hunter2"]) {
		assert.equal(sanitized.includes(secret), false, secret);
	}
	assert.match(sanitized, /Bearer \[REDACTED\]/);
	assert.match(sanitized, /Basic \[REDACTED\]/);
	assert.match(sanitized, /api_key=\[REDACTED\]/);
	assert.match(sanitized, /token=\[REDACTED\]/);
	assert.match(sanitized, /password: \[REDACTED\]/);
	assert.match(sanitized, /safe=value/);
	assert.equal(sanitizeString("authorization=plain-secret"), "authorization=[REDACTED]");
});

test("redacts structured key material and opaque credential formats", () => {
	const keys = ["id_token", "client_secret", "private_key"];
	for (const key of keys) assert.equal(isSecretKey(key), true, key);

	const sanitized = sanitizeString(
		"id_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P" +
			" client_secret: cs-live-9f8e7d6c" +
			" private_key=MIIEpAIBAAKCAQEA" +
			" aws=AKIAIOSFODNN7EXAMPLE",
	);
	for (const fragment of ["eyJhbGciOiJIUzI1NiJ9", "cs-live-9f8e7d6c", "MIIEpAIBAAKCAQEA", "AKIAIOSFODNN7EXAMPLE"]) {
		assert.equal(sanitized.includes(fragment), false, fragment);
	}
	assert.match(sanitized, /id_token=\[REDACTED\]/);
	assert.match(sanitized, /client_secret: \[REDACTED\]/);
	assert.match(sanitized, /private_key=\[REDACTED\]/);
	assert.match(sanitized, /aws=\[REDACTED\]/);

	assert.equal(
		sanitizeString("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\n-----END RSA PRIVATE KEY-----"),
		"[REDACTED]",
	);
	const structured = sanitize({ client_secret: "s", private_key: "p", id_token: "t", safe: "ok" });
	assert.deepEqual(structured, { client_secret: "[REDACTED]", private_key: "[REDACTED]", id_token: "[REDACTED]", safe: "ok" });
});
