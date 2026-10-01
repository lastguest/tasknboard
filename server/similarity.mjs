/**
 * Duplicate detection for task text: character trigrams per word and Jaccard
 * similarity. Pure functions; the store owns which tasks are compared.
 * The threshold and weight come from docs/contracts/similar-tasks.md.
 */

/** Only scores above this are reported as possible duplicates. */
export const similarityThreshold = 0.5;
/** How much the context adds to the title similarity. */
export const contextWeight = 0.1;
/** Only the start of a long context or description is compared. */
const contextLength = 500;

/** Lower case, no diacritics or punctuation, single spaces. */
export function normalize(text) {
  return String(text)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The trigrams of each word, padded so that short words and word starts count.
 * Words are taken separately, so their order does not change the set.
 */
export function trigrams(text) {
  const set = new Set();
  for (const word of normalize(text).split(" ")) {
    if (!word) continue;
    const padded = ` ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) set.add(padded.slice(i, i + 3));
  }
  return set;
}

/** |a ∩ b| / |a ∪ b|; 0 when both sets are empty. */
export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * A scorer for one query: title similarity, plus `contextWeight` times the
 * context similarity when both the query and the task have context.
 * Scores are in [0, 1 + contextWeight]. The context of a task is compared only
 * if it can still lift the score above the threshold, so the result for such
 * a task is its title score.
 */
export function similarityScorer(title, context = "") {
  const titleGrams = trigrams(title);
  const contextGrams = trigrams(String(context).slice(0, contextLength));
  return (task) => {
    const score = jaccard(titleGrams, trigrams(task.title));
    if (
      !contextGrams.size ||
      !task.description ||
      score + contextWeight <= similarityThreshold
    )
      return score;
    return (
      score +
      contextWeight *
        jaccard(contextGrams, trigrams(task.description.slice(0, contextLength)))
    );
  };
}
