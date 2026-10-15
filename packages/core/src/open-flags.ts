// Darwin sys/fcntl.h flags that Node does not export by name. Kept free of imports so a light
// process (the CLI) can use them without loading the catalog.
/** Refuses a symlink in every path component, unlike O_NOFOLLOW which checks only the leaf. */
export const O_NOFOLLOW_ANY = 0x20000000;
/** Takes an exclusive flock as part of open; with O_NONBLOCK a held lock fails with EAGAIN. */
export const O_EXLOCK = 0x20;
/** Shared flock at open: holders coexist, and an exclusive open fails while any is held. */
export const O_SHLOCK = 0x10;
