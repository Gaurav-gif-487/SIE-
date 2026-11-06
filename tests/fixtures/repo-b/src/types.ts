export interface Handler {
  handle(input: string): string;
}

export abstract class BaseHandler implements Handler {
  abstract handle(input: string): string;

  log(input: string): string {
    return `log:${input}`;
  }
}
