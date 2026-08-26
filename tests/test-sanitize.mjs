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
