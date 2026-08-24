import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Byte-for-byte the helper from runcrate_app `src/lib/utils.ts`. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * runcrate uses `class-variance-authority` for variant maps. cva is not a
 * dependency of this package and the brief forbids adding one, so variants are
 * plain records looked up by key and merged through `cn`. Same output, no extra
 * runtime, and the class strings stay copy-comparable with runcrate.
 */
export function variant<K extends string>(
  map: Record<K, string>,
  key: K | undefined,
  fallback: K,
): string {
  return map[key ?? fallback];
}
