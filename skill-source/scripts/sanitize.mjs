const REDACTED = "[REDACTED]";
const SECRET_KEYS = new Set([
	"authorization",
	"apikey",
	"api_key",
	"token",
	"access_token",
	"refresh_token",
	"id_token",
	"password",
	"passwd",
	"secret",
	"client_secret",
	"cookie",
	"cookies",
	"set-cookie",
	"private_key",
]);
const STRING_SECRET = /\b(authorization|api[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|client[_-]?secret|cookies?|set-cookie|private[_-]?key)\b(\s*[:=]\s*)(["']?)[^\s,;"'}]+\3/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g;
const AWS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export function isSecretKey(key) {
	return SECRET_KEYS.has(String(key).toLowerCase());
}

export function sanitizeString(value) {
	return String(value ?? "")
		.replace(/\bBearer\s+[^\s"']+/gi, `Bearer ${REDACTED}`)
		.replace(/\bBasic\s+[^\s"']+/gi, `Basic ${REDACTED}`)
		.replace(STRING_SECRET, (_, key, separator) => `${key}${separator}${REDACTED}`)
		.replace(JWT_PATTERN, REDACTED)
		.replace(AWS_KEY_PATTERN, REDACTED)
		.replace(PRIVATE_KEY_BLOCK, REDACTED);
}

export function sanitize(value) {
	if (typeof value === "string") return sanitizeString(value);
	if (Array.isArray(value)) return value.map(sanitize);
	if (!value || typeof value !== "object") return value;

	const output = {};
	for (const [key, child] of Object.entries(value)) {
		output[key] = isSecretKey(key) ? REDACTED : sanitize(child);
	}
	return output;
}
