// topics.js — a bank of easy, concrete story prompts.
// Prompts are deliberately open-ended and low-stakes so a human can write
// freely without "thinking too hard" (which would otherwise look like a bot
// staring at the screen). Each prompt should be answerable in ~300 chars.

export const TOPICS = [
  "a cat who decides to become a chef",
  "the best sandwich you have ever eaten",
  "a robot learning to dance for the first time",
  "what your pet does when nobody is home",
  "a rainy afternoon that turned out great",
  "a vegetable that secretly runs the fridge",
  "the day the moon came down for a visit",
  "your perfect lazy Sunday morning",
  "a sock that lost its partner in the laundry",
  "two clouds racing across the sky",
  "a grumpy teapot who refuses to whistle",
  "the smell of fresh bread on a cold day",
  "a snail who dreams of going fast",
  "what the streetlights talk about at night",
  "a backpack that is tired of being packed",
  "the first snowfall of the year",
  "a houseplant giving advice to its owner",
  "a spider redecorating its web for spring",
  "the last cookie in the jar",
  "a lighthouse that is afraid of the dark",
  "a pencil that has written too many lies",
  "your favorite thing about the ocean",
  "a dog who thinks it is a mail carrier",
  "the secret life of a coffee mug",
  "a balloon planning its big escape",
];

// Deterministic-ish picker that does not rely on Math.random for testability
// when a seed is supplied; falls back to crypto random in the browser.
export function pickTopic(seed) {
  let idx;
  if (typeof seed === "number") {
    idx = seed % TOPICS.length;
  } else if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    idx = buf[0] % TOPICS.length;
  } else {
    idx = Math.floor(Math.random() * TOPICS.length);
  }
  return { index: idx, text: TOPICS[idx] };
}
