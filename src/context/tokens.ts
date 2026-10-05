import type { TokenEstimator } from "../types.ts";

/** Rough approximation: about four characters per token. M4 replaces this with a more conservative estimator. */
export const charsPerTokenEstimator: TokenEstimator = {
  id: "chars/4",
  count: (text) => Math.ceil(text.length / 4),
};
