/**
 * The letter that stands in for a thing with no picture yet.
 *
 * Separate from `initialOf` in `people.ts`, which answers the same question
 * about a person and is documented as doing exactly that. This one is for the
 * name of a bill, an account or a budget category, and it differs in one way
 * that matters: it is safe for characters outside the basic plane, because a
 * household can call a category anything at all and `name[0]` on an emoji
 * takes half of it and renders a broken glyph.
 *
 * In its own file, and not in the component that uses it, so component files
 * go on exporting only components - which is what fast refresh needs. Same
 * reason `people.ts` exists.
 *
 * It is never read out: the name always sits beside the square, so the letter
 * is decorative and the markup marks it so.
 */

/**
 * The first character of a name, upper-cased, or null if there is not one.
 *
 * Null rather than an empty string, so the caller can tell "no letter" from
 * "a letter that happens to be blank" and draw nothing instead of an empty
 * square - which would read as a picture that failed to load.
 */
export function initialFor(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return null;

  /*
   * `Array.from` iterates by code point, so an emoji or any other astral
   * character comes out whole. `trimmed[0]` would take the leading surrogate
   * on its own, which renders as a replacement box.
   */
  const first = Array.from(trimmed)[0];
  if (first === undefined) return null;

  // Canadian English, which is how the name beside it is displayed.
  return first.toLocaleUpperCase("en-CA");
}
