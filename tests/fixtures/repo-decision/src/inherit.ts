import { hardAlias } from "./barrel.js";

export abstract class BaseService {
  abstract perform(): number;
}

export class DerivedService extends BaseService {
  perform(): number {
    return hardAlias();
  }
}
