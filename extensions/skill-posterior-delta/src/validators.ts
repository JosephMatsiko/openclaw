// Ajv-based schema validators for posterior delta + read marker.
//
// The dissent schema is registered (referenced by the posterior schema) but no
// validator is exposed for it directly — chuck-posterior-delta produces empty
// `dissent: []` arrays today.

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type { PosteriorDeltaConfig } from "./config.js";
import { readJson } from "./util.js";

export interface PosteriorValidators {
  validateDelta: ValidateFunction;
  validateReadMarker: ValidateFunction;
}

interface AjvLike {
  addSchema: (schema: unknown, key: string) => unknown;
  compile: (schema: unknown) => ValidateFunction;
}

type AjvConstructor = new (opts: Record<string, unknown>) => AjvLike;

export function createValidators(config: PosteriorDeltaConfig): PosteriorValidators {
  const AjvCtor = Ajv2020 as unknown as AjvConstructor;
  const ajv = new AjvCtor({ allErrors: true, strict: false, validateFormats: false });
  const dissentSchema = readJson<Record<string, unknown>>(config.dissentSchemaPath);
  const deltaSchema = readJson<Record<string, unknown>>(config.posteriorSchemaPath);
  const readMarkerSchema = readJson<Record<string, unknown>>(config.readMarkerSchemaPath);
  ajv.addSchema(dissentSchema, "dissent-record.schema.json");
  return {
    validateDelta: ajv.compile(deltaSchema),
    validateReadMarker: ajv.compile(readMarkerSchema),
  };
}

export function validateOrThrow(validate: ValidateFunction, value: unknown, label: string): void {
  if (validate(value)) return;
  const detail = (validate.errors ?? [])
    .map((err) => `${err.instancePath || "/"} ${err.message}`)
    .join("; ");
  throw new Error(`${label} failed schema validation: ${detail}`);
}
