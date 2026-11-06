/**
 * Minimal protobuf (proto3) wire-format encoder.
 *
 * SCIP's interchange format is a protobuf message (see scip.proto in
 * sourcegraph/scip). This repository has no protobuf codegen toolchain and
 * no network access to fetch one, so this module hand-encodes exactly the
 * wire format protoc would generate for the handful of message shapes SCIP
 * export needs: varints, length-delimited strings/bytes/submessages, and
 * packed repeated int32. It intentionally does not implement a decoder or
 * anything beyond what `src/scip/export.ts` uses.
 */

const WIRE_VARINT = 0;
const WIRE_LEN = 2;

export function tag(fieldNumber: number, wireType: number): Buffer {
  return varint((fieldNumber << 3) | wireType);
}

/** Unsigned varint. Every value this exporter writes is a non-negative field number, line/column, or enum ordinal. */
export function varint(value: number): Buffer {
  const bytes: number[] = [];
  let big = BigInt(Math.trunc(value));
  if (big < 0n) big &= 0xffffffffn; // shouldn't happen; guard against accidental negatives
  do {
    let b = Number(big & 0x7fn);
    big >>= 7n;
    if (big !== 0n) b |= 0x80;
    bytes.push(b);
  } while (big !== 0n);
  return Buffer.from(bytes);
}

export function fieldVarint(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([tag(fieldNumber, WIRE_VARINT), varint(value)]);
}

export function fieldString(fieldNumber: number, value: string): Buffer {
  const utf8 = Buffer.from(value, "utf8");
  return Buffer.concat([tag(fieldNumber, WIRE_LEN), varint(utf8.length), utf8]);
}

export function fieldBytes(fieldNumber: number, value: Buffer): Buffer {
  return Buffer.concat([tag(fieldNumber, WIRE_LEN), varint(value.length), value]);
}

/** Embedded message: same wire encoding as bytes/strings (length-delimited). */
export function fieldMessage(fieldNumber: number, encodedMessage: Buffer): Buffer {
  return fieldBytes(fieldNumber, encodedMessage);
}

/** proto3 packs repeated scalar numeric fields by default. */
export function fieldPackedVarints(fieldNumber: number, values: number[]): Buffer {
  const payload = Buffer.concat(values.map((v) => varint(v)));
  return fieldBytes(fieldNumber, payload);
}

export function concatFields(...fields: Buffer[]): Buffer {
  return Buffer.concat(fields);
}
