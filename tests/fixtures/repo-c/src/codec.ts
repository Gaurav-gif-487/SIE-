export interface Codec<T> {
  encode(value: T): string;
  decode(text: string): T;
}

export abstract class BaseCodec<T> implements Codec<T> {
  abstract encode(value: T): string;
  abstract decode(text: string): T;
  roundTrip(value: T): T {
    return this.decode(this.encode(value));
  }
}

export class Base64Codec extends BaseCodec<string> {
  encode(value: string): string {
    return Buffer.from(value, "utf8").toString("base64");
  }
  decode(text: string): string {
    return Buffer.from(text, "base64").toString("utf8");
  }
}

export class HexCodec extends BaseCodec<string> {
  encode(value: string): string {
    return Buffer.from(value, "utf8").toString("hex");
  }
  decode(text: string): string {
    return Buffer.from(text, "hex").toString("utf8");
  }
}

/** Name collision: `encode` with no relation to Codec at all. */
export class Telemetry {
  encode(value: string): string {
    return `telemetry:${value}`;
  }
}
