import { Base64Codec, BaseCodec, Codec, HexCodec, Telemetry } from "./codec.js";

export function pick(kind: "b64" | "hex"): Codec<string> {
  return kind === "b64" ? new Base64Codec() : new HexCodec();
}

/** virtual through the interface */
export function packViaInterface(value: string): string {
  const codec = pick("b64");
  return codec.encode(value);
}

/** virtual through the abstract base */
export function packViaBase(value: string, codec: BaseCodec<string>): string {
  return codec.encode(value);
}

/** statically pinned to Base64Codec */
export function packConcrete(value: string): string {
  return new Base64Codec().encode(value);
}

/** unrelated `encode`: a lexical matcher must not attribute this to Codec.encode */
export function packTelemetry(value: string): string {
  return new Telemetry().encode(value);
}

/** generic constrained to the interface */
export function packGeneric<C extends Codec<string>>(codec: C, value: string): string {
  return codec.encode(value);
}

/** dynamic dispatch: not statically decidable */
export function packDynamic(codec: Codec<string>, member: "encode" | "decode"): unknown {
  return (codec as unknown as Record<string, (x: string) => unknown>)[member]!("x");
}

/** callback attribution */
export function packAll(values: string[]): string[] {
  const codec = pick("hex");
  return values.map((v) => codec.encode(v));
}
