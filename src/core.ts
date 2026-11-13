// The one door to core. Core is a git dependency pinned to a commit (S3), and
// that commit is part of every variant hash.

export * from 'rpg-core';
export { showType, parseType } from 'rpg-core/src/types.ts';
export type { ValueType } from 'rpg-core/src/types.ts';
export type { FieldSpec, KindSpec, IntentSpec, SignalSpec } from 'rpg-core/src/compile/program.ts';

declare const __CORE_COMMIT__: string;
/** The core commit this build of the studio runs. */
export const CORE_COMMIT: string = __CORE_COMMIT__;
