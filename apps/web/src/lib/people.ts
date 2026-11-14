/**
 * How a person is shown: their first name, and the letter that stands for it.
 *
 * Both are derived from the name rather than stored. There is an `initial`
 * column, typed in separately when an account is made, and in one real
 * household the two people's badges both showed the same letter because of
 * it - which makes the badge useless for its one job, saying whose row this
 * is. A letter taken from the name cannot drift from the name.
 *
 * In their own file so that the component files go on exporting only
 * components, which is what fast refresh needs.
 */

/** The name to greet somebody by: everything before the first space. */
export function firstNameOf(name: string): string {
  const trimmed = name.trim();
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

/** The letter to show for a person. Empty only if their name is. */
export function initialOf(person: { readonly name: string }): string {
  // Upper case by Canadian English rules, which is also how the name is
  // displayed beside it.
  return firstNameOf(person.name).slice(0, 1).toLocaleUpperCase("en-CA");
}
