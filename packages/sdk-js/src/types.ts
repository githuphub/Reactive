// Public helper types derived from @liveforge/protocol (no wire types are redefined here).
import type { BUILTIN_SIGNALS, BuiltinSignalType } from "@liveforge/protocol";

type Docs = typeof BUILTIN_SIGNALS;
type FieldTs<F> = F extends "string"
  ? string
  : F extends "number"
    ? number
    : F extends "boolean"
      ? boolean
      : F extends "boolean|null"
        ? boolean | null
        : F extends "string[]"
        ? string[]
        : Record<string, unknown>;
type Required_<D> = { [K in keyof D as K extends `${string}?` ? never : K]: FieldTs<D[K]> };
type Optional_<D> = { [K in keyof D as K extends `${infer N}?` ? N : never]?: FieldTs<D[K]> };

/**
 * Typed data for a built-in signal, from protocol `BUILTIN_SIGNALS` (required + optional documented fields; extra
 * fields are allowed and stored). Example: `SignalData<"combat.hurt">` = `{source: string; damage: number; hp: number; attack?: string; ...}`.
 */
export type SignalData<T extends BuiltinSignalType> = Required_<Docs[T]["data"]> & Optional_<Docs[T]["data"]> & Record<string, unknown>;

/** Any other (custom, manifest-declared) signal type: excludes built-in names so those stay type-checked. */
export type CustomSignalType<T extends string> = T extends BuiltinSignalType ? never : T;
