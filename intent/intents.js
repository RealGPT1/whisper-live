export const INTENTS = [
  {
    name: 'search',
    triggers: ['search for', 'search', 'find', 'look up', 'lookup', 'look for', 'google', 'search up']
  },
  {
    name: 'navigate-to',
    triggers: ['i want to go to', 'show me', 'take me to', 'navigate to', 'go to', 'open', 'bring up', 'pull up', 'switch to']
  },
  {
    name: 'question',
    triggers: ['who is', 'what is', 'what are', 'tell me about', 'explain', 'how do', 'how does', 'why is', 'why does', 'when is', 'when did', 'where is', 'where did']
  }
];

// Levenshtein distance for fuzzy matching
function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i-1] === a[j-1]
        ? matrix[i-1][j-1]
        : Math.min(matrix[i-1][j-1] + 1, matrix[i][j-1] + 1, matrix[i-1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

// Check if two strings are similar (fuzzy match)
function fuzzyMatch(str, target, threshold = 0.3) {
  str = str.toLowerCase();
  target = target.toLowerCase();
  if (str === target) return true;
  if (str.includes(target) || target.includes(str)) return true;
  const distance = levenshtein(str, target);
  const maxLen = Math.max(str.length, target.length);
  return (distance / maxLen) <= threshold;
}

// Classify intent from speech text
export function classifyIntent(text) {
  const normalized = text.toLowerCase().trim();
  const words = normalized.split(/\s+/);

  for (const intent of INTENTS) {
    for (const trigger of intent.triggers) {
      const triggerWords = trigger.split(/\s+/);

      // Try exact phrase match first
      if (normalized.startsWith(trigger)) {
        const obj = normalized.slice(trigger.length).trim();
        return { intent: intent.name, object: obj || null, trigger };
      }

      // Try fuzzy match on trigger phrases
      for (let i = 0; i <= words.length - triggerWords.length; i++) {
        const slice = words.slice(i, i + triggerWords.length).join(' ');
        if (fuzzyMatch(slice, trigger)) {
          const obj = words.slice(i + triggerWords.length).join(' ');
          return { intent: intent.name, object: obj || null, trigger };
        }
      }

      // Single word trigger fuzzy match at start
      if (triggerWords.length === 1 && words.length > 0) {
        if (fuzzyMatch(words[0], trigger)) {
          const obj = words.slice(1).join(' ');
          return { intent: intent.name, object: obj || null, trigger };
        }
      }
    }
  }

  // Fallback: classify as 'other' with full text as object
  return { intent: 'other', object: normalized, trigger: null };
}
