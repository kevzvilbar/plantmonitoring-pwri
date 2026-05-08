// Text helpers
export function toSentence(s: string): string {
  if (!s) return s;
  const trimmed = s.trim().replace(/\s+/g, ' ');
  // Capitalize start of every sentence (after . ! ?)
  return trimmed.replace(/(^\s*\w|[.!?]\s+\w)/g, (m) => m.toUpperCase());
}

export function toTitle(s: string): string {
  if (!s) return s;
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => (w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join(' ');
}
