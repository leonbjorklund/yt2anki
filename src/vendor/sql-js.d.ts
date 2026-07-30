declare module "sql.js" {
  export interface Database {
    close(): void;
    export(): Uint8Array<ArrayBuffer>;
    run(sql: string, params?: unknown[]): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  export default function initSqlJs(options?: {
    locateFile?(file: string): string;
  }): Promise<SqlJsStatic>;
}
