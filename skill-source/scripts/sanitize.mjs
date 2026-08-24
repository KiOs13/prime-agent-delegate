const REDACTED = "[REDACTED]";
const SECRET_KEYS = new Set([
	"authorization",
	"apikey",
	"api_key",
	"token",
	"access_token",
	"refresh_token",
	"password",
	"passwd",
	"secret",
	"cookie",
	"cookies",
	"set-cookie",
]);
const STRING_SECRET = /\b(authorization|api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookies?|set-cookie)\b(\s*[:=]\s*)(["']?)[^\s,;"'}]+\3/gi;

export function isSecretKey(key) {
	return SECRET_KEYS.has(String(key).toLowerCase());
}

export function sanitizeString(value) {
	return String(value ?? "")
		.replace(/\bBearer\s+[^\s"']+/gi, `Bearer ${REDACTED}`)
		.replace(/\bBasic\s+[^\s"']+/gi, `Basic ${REDACTED}`)
		.replace(STRING_SECRET, (_, key, separator) => `${key}${separator}${REDACTED}`);
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
