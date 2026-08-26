export function redactValue(value: unknown): unknown {
  if (typeof value === "string")
    return value.replace(
      /(api[_-]?key|token|password|secret)\s*[:=]\s*\S+|bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9_-]{8,}/gi,
      (match) => {
        const separator = match.match(/\s*[:=]\s*/)?.[0];
        if (separator)
          return `${match.slice(0, match.indexOf(separator))}${separator}[REDACTED]`;
        if (/^bearer\s/i.test(match)) return "Bearer [REDACTED]";
        return "sk-[REDACTED]";
      },
    );
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED]" : redactValue(entry),
      ]),
    );
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /(api[_-]?key|token|password|secret|authorization)/i.test(key);
}
