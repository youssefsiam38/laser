/**
 * The file explorer's reply validator, on its own (M16-T31).
 *
 * `@lasercode/protocol`'s schemas are the app's only use of the schema library:
 * about 160 KiB of parser for one thing a conversation does not do until a
 * person types `@`. Keeping the import here, and asking for this module beside
 * the listing request rather than at startup, moves all of it into a chunk
 * that loads with the first directory page — in parallel with the page itself,
 * so the explorer waits for nothing extra.
 */
export { explorerListingSchema } from "@lasercode/protocol";
