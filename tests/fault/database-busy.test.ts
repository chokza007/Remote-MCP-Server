import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  DatabaseBusyError,
  DatabaseCapacityError,
  normalizeDatabaseError,
  openDatabase
} from "@remote-mcp/persistence";

describe("database pressure failures", () => {
  let root = "";
  afterEach(async () => rm(root, { recursive: true, force: true }));

  test("returns a retryable controlled error when SQLite stays busy", async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-db-busy-"));
    const filename = join(root, "busy.db");
    const holder = openDatabase({ filename, busyTimeoutMs: 5 });
    const contender = openDatabase({ filename, busyTimeoutMs: 5 });
    holder.read((connection) => {
      connection.exec("CREATE TABLE fixture(value TEXT); BEGIN EXCLUSIVE; INSERT INTO fixture VALUES ('held')");
    });
    try {
      expect(() => contender.writeTransaction((connection) => {
        connection.prepare("INSERT INTO fixture VALUES (?)").run("blocked");
      })).toThrow(DatabaseBusyError);
    } finally {
      holder.read((connection) => connection.exec("ROLLBACK"));
      contender.close();
      holder.close();
    }
  });

  test("classifies full-disk failures without exposing raw SQLite internals", () => {
    const normalized = normalizeDatabaseError(Object.assign(new Error("database or disk is full"), {
      code: "SQLITE_FULL"
    }));
    expect(normalized).toBeInstanceOf(DatabaseCapacityError);
    expect(normalized.message).toMatch(/capacity/i);
  });
});
