// Temporal for Vitest on Node 24, which has it only behind a flag. The dashboard uses the browser's own.
// oxlint-disable-next-line import/no-unassigned-import -- the polyfill installs the global Temporal
import "temporal-polyfill/global";
