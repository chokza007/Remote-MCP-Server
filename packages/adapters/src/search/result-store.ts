import type { OperationalDatabase } from "@remote-mcp/persistence";

import type { SearchPage, SearchRequest, SearchResult, SearchStatus } from "./search-service.js";

interface SearchRow {
  readonly id: string;
  readonly request_json: string;
  readonly state: SearchStatus["state"];
  readonly cursor_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const emptyMetrics = {
  scannedFiles: 0,
  scannedBytes: 0,
  matchedResults: 0,
  issues: 0,
  skippedBinary: 0,
  truncated: false,
  error: null as string | null
};

export class SearchResultStore {
  readonly #database: OperationalDatabase;

  public constructor(database: OperationalDatabase) {
    this.#database = database;
  }

  public create(id: string, request: SearchRequest, now: string): void {
    this.#database.writeTransaction((connection) => {
      connection.prepare(
        `INSERT INTO searches(id, workspace_id, request_json, state, cursor_json, created_at, updated_at)
         VALUES (?, NULL, ?, 'pending', ?, ?, ?)`
      ).run(id, JSON.stringify(request), JSON.stringify(emptyMetrics), now, now);
    });
  }

  public get(id: string): { readonly request: SearchRequest; readonly status: SearchStatus } {
    const row = this.#database.read((connection) =>
      connection.prepare("SELECT * FROM searches WHERE id = ?").get(id) as SearchRow | undefined
    );
    if (!row) throw new Error(`Unknown search: ${id}`);
    const metrics = row.cursor_json ? JSON.parse(row.cursor_json) as typeof emptyMetrics : emptyMetrics;
    return {
      request: JSON.parse(row.request_json) as SearchRequest,
      status: {
        searchId: id,
        state: row.state,
        ...metrics,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    };
  }

  public update(id: string, state: SearchStatus["state"], metrics: typeof emptyMetrics, now: string): void {
    this.#database.writeTransaction((connection) => {
      connection.prepare("UPDATE searches SET state = ?, cursor_json = ?, updated_at = ? WHERE id = ?")
        .run(state, JSON.stringify(metrics), now, id);
    });
  }

  public clearResults(id: string): void {
    this.#database.writeTransaction((connection) => {
      connection.prepare("DELETE FROM search_results WHERE search_id = ?").run(id);
    });
  }

  public append(id: string, sequence: number, result: SearchResult): void {
    this.#database.writeTransaction((connection) => {
      connection.prepare(
        "INSERT INTO search_results(search_id, sequence, result_json) VALUES (?, ?, ?)"
      ).run(id, sequence, JSON.stringify(result));
    });
  }

  public page(id: string, cursor: number, limit: number): SearchPage {
    this.get(id);
    const rows = this.#database.read((connection) =>
      connection.prepare(
        `SELECT sequence, result_json FROM search_results
         WHERE search_id = ? AND sequence >= ? ORDER BY sequence LIMIT ?`
      ).all(id, cursor, limit + 1) as Array<{ sequence: number; result_json: string }>
    );
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: visible.map((row) => JSON.parse(row.result_json) as SearchResult),
      nextCursor: hasMore ? (visible.at(-1)?.sequence ?? cursor) + 1 : null
    };
  }
}

export { emptyMetrics };
