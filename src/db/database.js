const { DatabaseSync } = require("node:sqlite");
const config = require("../config");
const { ensureDir } = require("../utils/fs");
const { schemaSql } = require("./schema");

let database;

function getDatabase() {
  if (!database) {
    ensureDir(config.paths.storageDir);
    database = new DatabaseSync(config.paths.databaseFile);
    database.exec("PRAGMA journal_mode = WAL;");
  }

  return database;
}

function initDatabase() {
  const db = getDatabase();
  db.exec(schemaSql);
  return db;
}

module.exports = {
  getDatabase,
  initDatabase
};
