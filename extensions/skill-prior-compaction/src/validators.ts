// Ajv-based validator for prior-compaction-decision.

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type { PriorCompactionConfig } from "./config.js";
import { readJson } from "./util.js";

interface AjvLike {
  addSchema: (schema: unknown, key: string) => unknown;
  compile: (schema: unknown) => ValidateFunction;
}

type AjvConstructor = new (opts: Record<string, unknown>) => AjvLike;

export function createDecisionValidator(config: PriorCompactionConfig): ValidateFunction {
  const AjvCtor = Ajv2020 as unknown as AjvConstructor;
  const ajv = new AjvCtor({ allErrors: true, strict: false, validateFormats: false });
  const schema = readJson<Record<string, unknown>>(config.compactionSchemaPath);
  return ajv.compile(schema);
}

export function validateOrThrow(validate: ValidateFunction, value: unknown, label: string): void {
  if (validate(value)) return;
  const detail = (validate.errors ?? [])
    .map((err) => `${err.instancePath || "/"} ${err.message}`)
    .join("; ");
  throw new Error(`${label} failed schema validation: ${detail}`);
}
