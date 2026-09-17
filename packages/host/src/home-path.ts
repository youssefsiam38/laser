const HOME_TOKEN = /^(?:~|%USERPROFILE%)(?=$|[\\/])/iu;

/** Expand the account-home spellings accepted by host-side path pickers. */
export function expandHomePath(path: string, home: string): string {
  return HOME_TOKEN.test(path) ? path.replace(HOME_TOKEN, () => home) : path;
}
