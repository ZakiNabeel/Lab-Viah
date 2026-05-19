// Best-effort repair for truncated Gemini JSON.
//
// Why this exists: Gemini Pro burns invisible "thinking" tokens against the
// same maxOutputTokens budget as the visible response. When the budget runs
// dry mid-response the visible JSON is cut off — usually inside a string or
// at the end of an array. Bumping the budget helps but doesn't eliminate it,
// so we try to close the JSON before falling back to deterministic output.
//
// Strategy (single pass through the text):
//   1. Walk char-by-char tracking string state + the bracket stack.
//   2. If we end inside a string, close the string.
//   3. Drop any trailing comma + whitespace.
//   4. Close any unclosed brackets in reverse-stack order.
//
// Not a general-purpose JSON5 parser. We assume valid JSON up to the
// truncation point — Gemini's JSON-mode output respects that in practice.

export function repairTruncatedJson(raw: string): string {
  const s = raw.trim();
  if (s.length === 0) return s;

  const stack: Array<'{' | '['> = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}') {
      if (stack[stack.length - 1] === '{') stack.pop();
    } else if (ch === ']') {
      if (stack[stack.length - 1] === '[') stack.pop();
    }
  }

  let out = s;
  if (inString) out += '"';
  // Strip trailing whitespace + dangling comma so `[1, 2, ` becomes `[1, 2`
  // before we close the array.
  out = out.replace(/[\s,]+$/u, '');
  // Strip trailing colon ("dimension": ) — happens when Pro truncates right
  // after a key. Without this we'd close the object with a dangling key.
  out = out.replace(/"\s*:\s*$/u, '');
  // Strip trailing comma after the colon-strip, if a comma surfaced.
  out = out.replace(/,\s*$/u, '');
  // Close brackets in reverse-stack order.
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    out += stack[i] === '{' ? '}' : ']';
  }
  return out;
}
