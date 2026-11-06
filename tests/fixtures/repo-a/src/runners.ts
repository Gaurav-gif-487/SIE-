export interface Runner {
  run(): string;
}

export class FastRunner implements Runner {
  run(): string {
    return "fast";
  }
}

export class SlowRunner implements Runner {
  run(): string {
    return "slow";
  }
}

export class BaseService {
  authenticate(token: string): boolean {
    return token.length > 0;
  }
}

export class AdminService extends BaseService {
  authenticate(token: string): boolean {
    return token.startsWith("admin");
  }
}
